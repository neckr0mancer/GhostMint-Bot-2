const assert = require('node:assert/strict');
const test = require('node:test');
const { createSeaDropDiscoveryService } = require('../src/mint/seaDropDiscoveryService');
const { TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE } = require('../src/mint/seaDropRegistry');

const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';
const CANONICAL_CORE = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const CHAINS = { ethereum: { chainId: 1 } };
const ZEROED_DROP = { mintPriceWei: '0', startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false };

function eventLog(address) {
  return TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE.encodeEventLog('AllowedSeaDropUpdated', [[address]]);
}

function fakeRepository(initial = null) {
  const saved = [];
  return {
    saved,
    async getSeaDrop() { return initial; },
    async saveSeaDrop(chain, contractAddress, value) { saved.push(value); return { ...value, resolvedAt: new Date() }; },
  };
}

// Real PublicDrop data by core address queried -- a core the token was never configured on (the
// canonical core, unless a test opts in via configuredAt) returns an all-zero struct rather than
// throwing, exactly like the real resolver does for an unconfigured mapping entry (see
// seaDropPublicDropResolver.js and seaDropDiscoveryService.js's viaCanonicalCore).
function fakePublicDropResolver({ configuredAt = {} } = {}) {
  return {
    calls: [],
    async getPublicDrop(chain, seaDropAddress) {
      this.calls.push(['getPublicDrop', seaDropAddress]);
      return configuredAt[seaDropAddress] || ZEROED_DROP;
    },
    async getAllowedFeeRecipients(chain, seaDropAddress) { this.calls.push(['getAllowedFeeRecipients', seaDropAddress]); return ['0x00000000000000000000000000000000000000E5']; },
  };
}

const REAL_DROP = { mintPriceWei: '1000', startTime: 1, endTime: 2, maxTotalMintableByWallet: 3, feeBps: 250, restrictFeeRecipients: false };

test('checks the canonical core first; a token never configured there (all-zero PublicDrop) falls through to the Etherscan Logs API', async () => {
  const http = { get: async () => ({ data: { status: '1', result: [eventLog(SEADROP)] } }) };
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver({ configuredAt: { [SEADROP]: REAL_DROP } });
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('should not reach RPC fallback'); } },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, SEADROP);
  assert.equal(result.discoverySource, 'etherscan-logs');
  assert.equal(repository.saved[0].address, SEADROP);
  assert.equal(repository.saved[0].feeRecipient.toLowerCase(), '0x00000000000000000000000000000000000000e5');
  // One canonical-core probe (zeroed, falls through) plus the real getPublicDrop+getAllowedFeeRecipients pair.
  assert.equal(publicDropResolver.calls.length, 3);
});

test('resolves directly against the canonical SeaDrop core when the token is configured there, with no log scanning at all', async () => {
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver({ configuredAt: { [CANONICAL_CORE]: REAL_DROP } });
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('should not reach log scanning at all'); } },
    publicDropResolver, chains: CHAINS, apiKey: null, repository, http: { get: async () => { throw new Error('should not be called'); } },
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, CANONICAL_CORE);
  assert.equal(result.discoverySource, 'canonical-core');
  assert.equal(result.publicDrop.mintPriceWei, '1000');
});

// Root-caused live 2026-08-19 from a real "simulating this call failed with no reason given"
// report: robinhood was missing from CANONICAL_SEADROP_CORE entirely even though the same core
// address is live there too, so every SeaDrop mint on that chain fell through canonical-core
// (skipped), Etherscan (doesn't cover this chain), and eth_getLogs (needs archive access most
// public RPCs reject) to the wrong plain mint(uint256) assumption.
test('resolves directly against the canonical SeaDrop core on robinhood too, not just the original four chains', async () => {
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver({ configuredAt: { [CANONICAL_CORE]: REAL_DROP } });
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('should not reach log scanning at all'); } },
    publicDropResolver, chains: { robinhood: { chainId: 137893 } }, apiKey: null, repository, http: { get: async () => { throw new Error('should not be called'); } },
  });
  const result = await service.resolve('robinhood', CONTRACT);
  assert.equal(result.address, CANONICAL_CORE);
  assert.equal(result.discoverySource, 'canonical-core');
  assert.equal(result.publicDrop.mintPriceWei, '1000');
});

test('falls back to raw eth_getLogs when Etherscan is unavailable (no API key)', async () => {
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver({ configuredAt: { [SEADROP]: REAL_DROP } });
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async (chain, name, operation) => operation({ getLogs: async () => [eventLog(SEADROP)] }) },
    publicDropResolver, chains: CHAINS, apiKey: null, repository,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, SEADROP);
  assert.equal(result.discoverySource, 'eth_getLogs');
});

test('falls back to raw eth_getLogs when the Etherscan call itself throws', async () => {
  const http = { get: async () => { throw new Error('network error'); } };
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver({ configuredAt: { [SEADROP]: REAL_DROP } });
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async (chain, name, operation) => operation({ getLogs: async () => [eventLog(SEADROP)] }) },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, SEADROP);
  assert.equal(result.discoverySource, 'eth_getLogs');
});

test('returns unknown without throwing when every discovery tier fails, and never calls the PublicDrop resolver for pricing', async () => {
  const http = { get: async () => { throw new Error('network error'); } };
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver();
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('archive request rejected'); } },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, null);
  assert.equal(result.discoverySource, null);
  // The canonical-core probe itself still calls getPublicDrop once (and finds nothing configured);
  // it just never proceeds to price/fee-recipient resolution for a genuinely undiscovered drop.
  assert.equal(publicDropResolver.calls.length, 1);
  assert.equal(repository.saved[0].address, null);
});

test('does not treat an unconfigured canonical core as SeaDrop just because the call succeeds', async () => {
  const http = { get: async () => ({ data: { status: '0', result: [] } }) };
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver();
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async (chain, name, operation) => operation({ getLogs: async () => [] }) },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, null);
});

test('an already-cached row is returned immediately without any discovery calls', async () => {
  const cached = { address: SEADROP, discoverySource: 'etherscan-logs', resolvedAt: new Date() };
  const repository = fakeRepository(cached);
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('should not be called'); } },
    publicDropResolver: { getPublicDrop: async () => { throw new Error('should not be called'); }, getAllowedFeeRecipients: async () => { throw new Error('should not be called'); } },
    chains: CHAINS, apiKey: 'test-key', repository, http: { get: async () => { throw new Error('should not be called'); } },
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result, cached);
  assert.equal(repository.saved.length, 0);
});
