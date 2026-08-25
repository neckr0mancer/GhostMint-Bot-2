const axios = require('axios');
const { TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE } = require('./seaDropRegistry');

// OpenSea's official SeaDrop v1.0 core, deployed at this same address via CREATE2 on every chain
// it supports (confirmed against Etherscan's own "SeaDrop"/OpenSea label and the
// github.com/ProjectOpenSea/seadrop source link on this address). Checking it directly is a single
// eth_call with no history to scan -- reliable even for a token whose AllowedSeaDropUpdated event
// was never emitted (e.g. set once in the constructor and never updated since, which some deployed
// tokens genuinely do), where log-scanning below can never find anything no matter how well it runs.
// robinhood was missing here entirely -- live-confirmed 2026-08-19 that the same core address has
// real code on Robinhood chain and correctly answers getPublicDrop for a real drop there, so every
// SeaDrop mint on that chain was silently falling through to the two much weaker discovery tiers
// below (Etherscan's Logs API doesn't cover this chain; eth_getLogs needs archive-node access most
// public RPCs reject), then further through to the plain mint(uint256) assumption once neither
// found anything -- producing a 0-value call to a contract that has no such function at all, which
// is exactly the "simulating this call failed with no reason given" error this was root-caused from.
const CANONICAL_SEADROP_CORE = Object.freeze({
  ethereum: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  base: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  arbitrum: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  polygon: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  ink: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
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

  // MINT-001 (Model 2 phase-1): the transient taxonomy must match the transport reality, not just
  // four codes -- ECONNRESET/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN, axios timeouts, and rate-limit
  // responses are all "discovery incomplete". Anything transient here must reach resolve()'s
  // no-cache guard, or a single network blip poisons the negative cache for the contract's life.
  function isTransientDiscoveryError(error) {
    const code = error?.code;
    const msg = String(error?.message || '').toLowerCase();
    // MINT-001 (Model 2 re-review): full transport taxonomy — a miss here poisons the cache.
    if (['RPC_UNAVAILABLE', 'NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET',
      'ECONNREFUSED', 'EAI_AGAIN', 'ECONNABORTED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
      'EPIPE', 'ERR_NETWORK', 'ERR_BAD_RESPONSE', 'ERR_CANCELED'].includes(code)) return true;
    if (error?.cause?.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
      'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(error.cause.code)) return true;
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('connection reset')
      || msg.includes('rate limit') || msg.includes('too many requests')) return true;
    const status = error?.response?.status ?? error?.status;
    if (status === 429 || status === 408 || (Number.isInteger(status) && status >= 500)) return true;
    return false;
  }

  async function viaCanonicalCore(chain, contractAddress) {
    const address = CANONICAL_SEADROP_CORE[chain];
    if (!address) return undefined;
    try {
      const publicDrop = await publicDropResolver.getPublicDrop(chain, address, contractAddress);
      if (!publicDrop) return undefined;
      if (!publicDrop.startTime && !publicDrop.endTime && !publicDrop.maxTotalMintableByWallet) return undefined;
      return address;
    } catch (error) {
      if (isTransientDiscoveryError(error)) throw error;
      return undefined;
    }
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
      const response = await http.get(endpoint, { timeout: timeoutMs, maxContentLength: 1_000_000, params: {
        chainid: String(definition.chainId), module: 'logs', action: 'getLogs',
        address: contractAddress, topic0, fromBlock: 0, toBlock: 'latest', apikey: apiKey,
      } });
      if (String(response.data?.status) !== '1' || !Array.isArray(response.data?.result)) {
        // MINT-001 (Model 2 re-review): Etherscan returns HTTP 200 with a rate-limit body.
        const body = String(response.data?.result || response.data?.message || '');
        if (/rate limit|too many|Max rate/i.test(body)) {
          throw Object.assign(new Error(`Etherscan rate limit: ${body}`), { code: 'RATE_LIMITED' });
        }
        return undefined;
      }
      return decodeLatestAddress(response.data.result);
    } catch (error) {
      if (isTransientDiscoveryError(error)) throw error;
      return undefined;
    }
  }

  async function viaRpc(chain, contractAddress) {
    try {
      const logs = await providerService.perform(chain, 'seaDropAllowedSeaDropLogs', provider =>
        provider.getLogs({ address: contractAddress, topics: [topic0], fromBlock: 0, toBlock: 'latest' }));
      return decodeLatestAddress(logs);
    } catch (error) {
      if (isTransientDiscoveryError(error)) throw error;
      return undefined;
    }
  }

  async function resolve(chain, contractAddress) {
    const cached = await repository.getSeaDrop(chain, contractAddress);
    if (cached) return cached;

    let transientFailure = false;
    let address;
    try {
      address = await viaCanonicalCore(chain, contractAddress);
    } catch (error) {
      if (isTransientDiscoveryError(error)) { transientFailure = true; address = undefined; }
      else throw error;
    }
    let discoverySource = address ? 'canonical-core' : null;
    if (!address) {
      try {
        address = await viaEtherscan(chain, contractAddress);
      } catch (error) {
        if (isTransientDiscoveryError(error)) { transientFailure = true; address = undefined; }
        else throw error;
      }
      discoverySource = address ? 'etherscan-logs' : null;
    }
    if (!address) {
      try {
        address = await viaRpc(chain, contractAddress);
      } catch (error) {
        if (isTransientDiscoveryError(error)) { transientFailure = true; address = undefined; }
        else throw error;
      }
      discoverySource = address ? 'eth_getLogs' : null;
    }

    let publicDrop = null;
    let feeRecipient = null;
    if (address) {
      publicDrop = await publicDropResolver.getPublicDrop(chain, address, contractAddress);
      const allowed = await publicDropResolver.getAllowedFeeRecipients(chain, address, contractAddress);
      feeRecipient = allowed[0] ?? null;
    }

    // If every tier failed transiently, do not cache the negative result forever -- the next
    // call should retry discovery instead of serving a permanently poisoned "not SeaDrop" entry.
    if (!address && transientFailure) {
      return { address: null, discoverySource: null, publicDrop: null, feeRecipient: null };
    }

    return repository.saveSeaDrop(chain, contractAddress, { address: address || null, discoverySource, publicDrop, feeRecipient });
  }

  return { resolve };
}

module.exports = { createSeaDropDiscoveryService };
