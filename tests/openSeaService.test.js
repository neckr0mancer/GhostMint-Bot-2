const assert = require('node:assert/strict');
const test = require('node:test');
const { createOpenSeaService } = require('../src/mint/openSeaService');

const CONTRACT = '0x00000000000000000000000000000000000000C3';

function fakeRepository(initial = null) {
  const saved = [];
  return {
    saved,
    async getOpenSea() { return initial; },
    async saveOpenSea(chain, contractAddress, value) { saved.push(value); return { ...value, resolvedAt: new Date() }; },
  };
}

test('fetches the collection slug, then its details and stats, and saves the combined metadata', async () => {
  const calls = [];
  const http = { get: async url => {
    calls.push(url);
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'cool-cats' } };
    if (url.endsWith('/collections/cool-cats')) return { data: { name: 'Cool Cats', description: 'A collection', image_url: 'https://example.com/x.png' } };
    if (url.endsWith('/collections/cool-cats/stats')) return { data: { total: { floor_price: 0.5, floor_price_symbol: 'ETH' } } };
    throw new Error(`unexpected url ${url}`);
  } };
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result.name, 'Cool Cats');
  assert.equal(result.description, 'A collection');
  assert.equal(result.imageUrl, 'https://example.com/x.png');
  assert.equal(result.floorPrice, 0.5);
  assert.equal(result.floorPriceSymbol, 'ETH');
  assert.equal(calls.length, 3);
});

test('returns empty (never throws) when no API key is configured, and does not call http at all', async () => {
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: null, repository, http: { get: async () => { throw new Error('should not be called'); } } });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result.name, null);
  assert.equal(repository.saved[0].name, null);
});

test('returns empty when the chain has no OpenSea mapping, without calling http', async () => {
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http: { get: async () => { throw new Error('should not be called'); } } });
  const result = await service.getCollectionMetadata('robinhood', CONTRACT);
  assert.equal(result.name, null);
});

test('returns empty when the contract has no OpenSea collection slug', async () => {
  const http = { get: async () => ({ data: {} }) };
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result.name, null);
});

test('a network failure or timeout degrades to empty metadata instead of throwing', async () => {
  const http = { get: async () => { throw new Error('network error'); } };
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result.name, null);
  assert.equal(repository.saved.length, 1);
});

test('a stats-only failure still returns the collection fields that did resolve', async () => {
  const http = { get: async url => {
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'cool-cats' } };
    if (url.endsWith('/collections/cool-cats')) return { data: { name: 'Cool Cats' } };
    if (url.endsWith('/collections/cool-cats/stats')) throw new Error('stats unavailable');
    throw new Error(`unexpected url ${url}`);
  } };
  const repository = fakeRepository();
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result.name, 'Cool Cats');
  assert.equal(result.floorPrice, null);
});

test('an already-cached row is returned immediately without any http calls', async () => {
  const cached = { name: 'Cached Collection', resolvedAt: new Date() };
  const repository = fakeRepository(cached);
  const service = createOpenSeaService({ apiKey: 'test-key', repository, http: { get: async () => { throw new Error('should not be called'); } } });
  const result = await service.getCollectionMetadata('ethereum', CONTRACT);
  assert.equal(result, cached);
  assert.equal(repository.saved.length, 0);
});

// Section Q -- resolving an opensea.io collection link's slug to its contract address.
test('resolveCollectionContract returns the first contract deployed on a chain this app supports', async () => {
  const http = { get: async url => {
    if (url.endsWith('/collections/cool-cats')) {
      return { data: { contracts: [{ address: '0xAAA', chain: 'matic' }, { address: '0xBBB', chain: 'ethereum' }] } };
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const result = await service.resolveCollectionContract('cool-cats', ['ethereum', 'base']);
  assert.deepEqual(result, { chain: 'ethereum', contractAddress: '0xBBB' });
});

test('resolveCollectionContract returns null when none of the collection\'s chains are supported', async () => {
  const http = { get: async () => ({ data: { contracts: [{ address: '0xAAA', chain: 'matic' }] } }) };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const result = await service.resolveCollectionContract('cool-cats', ['ethereum']);
  assert.equal(result, null);
});

test('resolveCollectionContract returns null without calling http when no API key is configured', async () => {
  const service = createOpenSeaService({ apiKey: null, repository: fakeRepository(), http: { get: async () => { throw new Error('should not be called'); } } });
  const result = await service.resolveCollectionContract('cool-cats', ['ethereum']);
  assert.equal(result, null);
});

test('resolveCollectionContract returns null (never throws) on a network failure or an unrecognized response shape', async () => {
  const failing = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => { throw new Error('network error'); } } });
  assert.equal(await failing.resolveCollectionContract('cool-cats', ['ethereum']), null);
  const malformed = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => ({ data: {} }) } });
  assert.equal(await malformed.resolveCollectionContract('cool-cats', ['ethereum']), null);
});
