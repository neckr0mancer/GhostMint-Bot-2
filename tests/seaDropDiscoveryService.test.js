const assert = require('node:assert/strict');
const test = require('node:test');
const { createSeaDropDiscoveryService } = require('../src/mint/seaDropDiscoveryService');
const { TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE } = require('../src/mint/seaDropRegistry');

const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';
const CHAINS = { ethereum: { chainId: 1 } };

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

function fakePublicDropResolver() {
  return {
    calls: [],
    async getPublicDrop(chain, seaDropAddress) { this.calls.push(['getPublicDrop', seaDropAddress]); return { mintPriceWei: '1000', startTime: 1, endTime: 2, maxTotalMintableByWallet: 3, feeBps: 250, restrictFeeRecipients: false }; },
    async getAllowedFeeRecipients(chain, seaDropAddress) { this.calls.push(['getAllowedFeeRecipients', seaDropAddress]); return ['0x00000000000000000000000000000000000000E5']; },
  };
}

test('resolves the SeaDrop core address via the Etherscan Logs API when configured, then fetches PublicDrop', async () => {
  const http = { get: async () => ({ data: { status: '1', result: [eventLog(SEADROP)] } }) };
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver();
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async () => { throw new Error('should not reach RPC fallback'); } },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, SEADROP);
  assert.equal(result.discoverySource, 'etherscan-logs');
  assert.equal(repository.saved[0].address, SEADROP);
  assert.equal(repository.saved[0].feeRecipient.toLowerCase(), '0x00000000000000000000000000000000000000e5');
  assert.equal(publicDropResolver.calls.length, 2);
});

test('falls back to raw eth_getLogs when Etherscan is unavailable (no API key)', async () => {
  const repository = fakeRepository();
  const publicDropResolver = fakePublicDropResolver();
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
  const publicDropResolver = fakePublicDropResolver();
  const service = createSeaDropDiscoveryService({
    providerService: { perform: async (chain, name, operation) => operation({ getLogs: async () => [eventLog(SEADROP)] }) },
    publicDropResolver, chains: CHAINS, apiKey: 'test-key', repository, http,
  });
  const result = await service.resolve('ethereum', CONTRACT);
  assert.equal(result.address, SEADROP);
  assert.equal(result.discoverySource, 'eth_getLogs');
});

test('returns unknown without throwing when both discovery tiers fail, and never calls the PublicDrop resolver', async () => {
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
  assert.equal(publicDropResolver.calls.length, 0);
  assert.equal(repository.saved[0].address, null);
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
