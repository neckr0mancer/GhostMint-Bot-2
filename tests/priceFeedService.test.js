const assert = require('node:assert/strict');
const test = require('node:test');
const { createPriceFeedService } = require('../src/mint/priceFeedService');

test('fetches and returns the USD price for a mapped symbol', async () => {
  const http = { get: async (url, options) => {
    assert.equal(options.params.ids, 'ethereum');
    return { data: { ethereum: { usd: 3200.5 } } };
  } };
  const service = createPriceFeedService({ http });
  assert.equal(await service.getUsdPrice('ETH'), 3200.5);
});

test('maps MATIC to matic-network and is case-insensitive', async () => {
  const calls = [];
  const http = { get: async (url, options) => { calls.push(options.params.ids); return { data: { 'matic-network': { usd: 0.5 } } }; } };
  const service = createPriceFeedService({ http });
  assert.equal(await service.getUsdPrice('matic'), 0.5);
  assert.deepEqual(calls, ['matic-network']);
});

test('returns null (never throws) for an unmapped symbol, without calling http', async () => {
  const service = createPriceFeedService({ http: { get: async () => { throw new Error('should not be called'); } } });
  assert.equal(await service.getUsdPrice('SOL'), null);
  assert.equal(await service.getUsdPrice(''), null);
});

test('returns null (never throws) on a network failure with nothing cached yet', async () => {
  const http = { get: async () => { throw new Error('network error'); } };
  const service = createPriceFeedService({ http });
  assert.equal(await service.getUsdPrice('ETH'), null);
});

test('a later failure falls back to the last successfully cached price instead of null', async () => {
  let now = 0;
  let fail = false;
  const http = { get: async () => { if (fail) throw new Error('network error'); return { data: { ethereum: { usd: 3000 } } }; } };
  const service = createPriceFeedService({ http, now: () => now, ttlMs: 1_000 });
  assert.equal(await service.getUsdPrice('ETH'), 3000);
  now = 5_000;
  fail = true;
  assert.equal(await service.getUsdPrice('ETH'), 3000);
});

test('serves a fresh price from cache without a second http call within the TTL', async () => {
  let now = 0;
  let calls = 0;
  const http = { get: async () => { calls += 1; return { data: { ethereum: { usd: 3000 } } }; } };
  const service = createPriceFeedService({ http, now: () => now, ttlMs: 1_000 });
  await service.getUsdPrice('ETH');
  now = 500;
  await service.getUsdPrice('ETH');
  assert.equal(calls, 1);
  now = 1_500;
  await service.getUsdPrice('ETH');
  assert.equal(calls, 2);
});
