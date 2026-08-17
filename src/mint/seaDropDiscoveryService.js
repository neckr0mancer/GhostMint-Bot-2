const axios = require('axios');
const { TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE } = require('./seaDropRegistry');

// OpenSea's official SeaDrop v1.0 core, deployed at this same address via CREATE2 on every chain
// it supports (confirmed against Etherscan's own "SeaDrop"/OpenSea label and the
// github.com/ProjectOpenSea/seadrop source link on this address). Checking it directly is a single
// eth_call with no history to scan -- reliable even for a token whose AllowedSeaDropUpdated event
// was never emitted (e.g. set once in the constructor and never updated since, which some deployed
// tokens genuinely do), where log-scanning below can never find anything no matter how well it runs.
const CANONICAL_SEADROP_CORE = Object.freeze({
  ethereum: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  base: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  arbitrum: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  polygon: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
});

// Discovers which SeaDrop core contract a token has configured as allowed to mint it. Three tiers,
// all non-throwing, tried fastest/most-reliable first:
//   1. The canonical core directly (see above) -- a token never configured there returns an
//      all-zero PublicDrop struct rather than reverting (plain Solidity mapping-default behavior),
//      so startTime/endTime/maxTotalMintableByWallet all being zero is treated as "not actually
//      configured here" rather than a real free-priced drop (which would still have real timing/
//      limits even at price 0).
//   2. Etherscan's Logs API, reading the token's own AllowedSeaDropUpdated(address[]) event log
//      (indexes full history itself, sidesteps free-RPC "archive node" rejections) -- skipped
//      entirely when ETHERSCAN_API_KEY isn't configured. Only useful for a non-canonical core.
//   3. One unbounded eth_getLogs call via the configured provider. No chunked/paginated historical
//      scanning -- if this fails (rate limit, archive-node rejection, timeout), the drop is simply
//      "not auto-discoverable", same "unknown is a valid outcome" philosophy as
//      contractValueResolver.js.
// Once a core address is found, resolves PublicDrop pricing/limits and a default allowed fee
// recipient from it, then caches everything together.
function createSeaDropDiscoveryService({ providerService, publicDropResolver, chains, apiKey, repository,
  endpoint = 'https://api.etherscan.io/v2/api', http = axios, timeoutMs = 10_000 }) {
  const topic0 = TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE.getEvent('AllowedSeaDropUpdated').topicHash;

  async function viaCanonicalCore(chain, contractAddress) {
    const address = CANONICAL_SEADROP_CORE[chain];
    if (!address) return undefined;
    const publicDrop = await publicDropResolver.getPublicDrop(chain, address, contractAddress);
    if (!publicDrop) return undefined;
    if (!publicDrop.startTime && !publicDrop.endTime && !publicDrop.maxTotalMintableByWallet) return undefined;
    return address;
  }

  function decodeLatestAddress(logs) {
    if (!logs.length) return null;
    const latest = logs[logs.length - 1];
    let parsed;
    try { parsed = TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE.decodeEventLog('AllowedSeaDropUpdated', latest.data, latest.topics); }
    catch { return null; }
    const addresses = [...parsed[0]];
    return addresses.length ? addresses[addresses.length - 1] : null;
  }

  async function viaEtherscan(chain, contractAddress) {
    if (!apiKey) return undefined;
    const definition = chains[chain];
    if (!definition) return undefined;
    try {
      const response = await http.get(endpoint, { timeout: timeoutMs, params: {
        chainid: String(definition.chainId), module: 'logs', action: 'getLogs',
        address: contractAddress, topic0, fromBlock: 0, toBlock: 'latest', apikey: apiKey,
      } });
      if (String(response.data?.status) !== '1' || !Array.isArray(response.data?.result)) return undefined;
      return decodeLatestAddress(response.data.result);
    } catch {
      return undefined;
    }
  }

  async function viaRpc(chain, contractAddress) {
    try {
      const logs = await providerService.perform(chain, 'seaDropAllowedSeaDropLogs', provider =>
        provider.getLogs({ address: contractAddress, topics: [topic0], fromBlock: 0, toBlock: 'latest' }));
      return decodeLatestAddress(logs);
    } catch {
      return undefined;
    }
  }

  async function resolve(chain, contractAddress) {
    const cached = await repository.getSeaDrop(chain, contractAddress);
    if (cached) return cached;

    let address = await viaCanonicalCore(chain, contractAddress);
    let discoverySource = address ? 'canonical-core' : null;
    if (!address) {
      address = await viaEtherscan(chain, contractAddress);
      discoverySource = address ? 'etherscan-logs' : null;
    }
    if (!address) {
      address = await viaRpc(chain, contractAddress);
      discoverySource = address ? 'eth_getLogs' : null;
    }

    let publicDrop = null;
    let feeRecipient = null;
    if (address) {
      publicDrop = await publicDropResolver.getPublicDrop(chain, address, contractAddress);
      const allowed = await publicDropResolver.getAllowedFeeRecipients(chain, address, contractAddress);
      feeRecipient = allowed[0] ?? null;
    }

    return repository.saveSeaDrop(chain, contractAddress, { address: address || null, discoverySource, publicDrop, feeRecipient });
  }

  return { resolve };
}

module.exports = { createSeaDropDiscoveryService };
