const axios = require('axios');
const { TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE } = require('./seaDropRegistry');

// Discovers which SeaDrop core contract a token has configured as allowed to mint it, by reading
// the token's own AllowedSeaDropUpdated(address[]) event log. Two tiers, both non-throwing:
//   1. Etherscan's Logs API (indexes full history itself, sidesteps free-RPC "archive node"
//      rejections) -- skipped entirely when ETHERSCAN_API_KEY isn't configured.
//   2. One unbounded eth_getLogs call via the configured provider. No chunked/paginated historical
//      scanning -- if this fails (rate limit, archive-node rejection, timeout), the drop is simply
//      "not auto-discoverable", same "unknown is a valid outcome" philosophy as
//      contractValueResolver.js.
// Once a core address is found, resolves PublicDrop pricing/limits and a default allowed fee
// recipient from it, then caches everything together.
function createSeaDropDiscoveryService({ providerService, publicDropResolver, chains, apiKey, repository,
  endpoint = 'https://api.etherscan.io/v2/api', http = axios, timeoutMs = 10_000 }) {
  const topic0 = TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE.getEvent('AllowedSeaDropUpdated').topicHash;

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

    let address = await viaEtherscan(chain, contractAddress);
    let discoverySource = address ? 'etherscan-logs' : null;
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
