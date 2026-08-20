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
  const result = await service.getCollectionMetadata('not-a-real-chain', CONTRACT);
  assert.equal(result.name, null);
});

// Regression: robinhood was missing from OPENSEA_CHAIN_SLUGS entirely (confirmed live -- OpenSea's
// own API reports Robinhood Chain collections under chain identifier "robinhood"), silently
// degrading collection metadata, live stats, and opensea.io/collection link resolution for every
// Robinhood Chain contract even with a working API key. This asserts it is mapped, not just that
// some other chain is.
test('robinhood is a mapped OpenSea chain, not treated as unsupported', async () => {
  const calls = [];
  const http = { get: async url => {
    calls.push(url);
    if (url.includes('/chain/robinhood/contract/')) return { data: { collection: 'market-arcana' } };
    if (url.endsWith('/collections/market-arcana')) return { data: { name: 'MARKET ARCANA' } };
    if (url.endsWith('/collections/market-arcana/stats')) return { data: { total: { floor_price: 1 } } };
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const result = await service.getCollectionMetadata('robinhood', CONTRACT);
  assert.equal(result.name, 'MARKET ARCANA');
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

// Regression: this is the exact shape of a real reported failure -- pasting
// https://opensea.io/collection/fish-it-813600972 (a genuine Robinhood Chain collection) silently
// failed to resolve because robinhood was missing from OPENSEA_CHAIN_SLUGS, even though robinhood
// is one of this app's configured supportedChains.
test('resolveCollectionContract resolves a Robinhood Chain collection, not just the more common chains', async () => {
  const http = { get: async url => {
    if (url.endsWith('/collections/fish-it-813600972')) {
      return { data: { contracts: [{ address: '0x8052f4683a8b3572af3ebadfacfe8bcccebcd294', chain: 'robinhood' }] } };
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const result = await service.resolveCollectionContract('fish-it-813600972', ['ethereum', 'robinhood']);
  assert.deepEqual(result, { chain: 'robinhood', contractAddress: '0x8052f4683a8b3572af3ebadfacfe8bcccebcd294' });
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

// Section AD Tier 1 -- live collection stats for the collection info card. Deliberately never
// cached (unlike getCollectionMetadata above): volume is a rolling window that goes stale within
// minutes, so this always calls out fresh.
test('getCollectionStats reads floor price, owner count, and every volume/sales window from a real-shaped stats response', async () => {
  const calls = [];
  const http = { get: async url => {
    calls.push(url);
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'cool-cats' } };
    if (url.endsWith('/collections/cool-cats/stats')) {
      return { data: {
        total: { volume: 1580057.5, sales: 57279, num_owners: 5600, floor_price: 8.049, floor_price_symbol: 'ETH' },
        intervals: [
          { interval: 'one_day', volume: 72.9, sales: 8 },
          { interval: 'seven_day', volume: 330.5, sales: 35 },
          { interval: 'thirty_day', volume: 1544.6, sales: 173 },
        ],
      } };
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const stats = await service.getCollectionStats('ethereum', CONTRACT);
  assert.equal(stats.floorPrice, 8.049);
  assert.equal(stats.floorPriceSymbol, 'ETH');
  assert.equal(stats.numOwners, 5600);
  assert.deepEqual(stats.volume, { oneDay: 72.9, sevenDay: 330.5, thirtyDay: 1544.6, allTime: 1580057.5 });
  assert.deepEqual(stats.sales, { oneDay: 8, sevenDay: 35, thirtyDay: 173, allTime: 57279 });
  // Only the stats endpoint is called, not the paired /collections/{slug} metadata call
  // getCollectionMetadata's fetchCollectionDetails makes -- the card's live refresh has no use for
  // name/description on every tap, only on first resolve.
  assert.ok(!calls.some(url => url.endsWith('/collections/cool-cats')), 'must not fetch collection metadata, only stats');
});

test('getCollectionStats returns an all-null shape (never throws) when unconfigured, unsupported, or the API fails', async () => {
  const noKey = createOpenSeaService({ apiKey: null, repository: fakeRepository(), http: { get: async () => { throw new Error('should not be called'); } } });
  assert.deepEqual(await noKey.getCollectionStats('ethereum', CONTRACT), {
    floorPrice: null, floorPriceSymbol: null, numOwners: null,
    volume: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null },
    sales: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null },
  });

  const unsupportedChain = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => { throw new Error('should not be called'); } } });
  assert.equal((await unsupportedChain.getCollectionStats('not-a-real-chain', CONTRACT)).floorPrice, null);

  const noSlug = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => ({ data: {} }) } });
  assert.equal((await noSlug.getCollectionStats('ethereum', CONTRACT)).floorPrice, null);

  const networkFailure = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => { throw new Error('network error'); } } });
  assert.equal((await networkFailure.getCollectionStats('ethereum', CONTRACT)).floorPrice, null);
});

// Section AF -- reading real phase data from OpenSea's Drops API instead of guessing from the
// single mutable on-chain PublicDrop struct. Response shape live-verified against
// docs.opensea.io/reference/get_drop_by_slug: price is a decimal wei string, start/end times are
// ISO 8601 strings (converted to unix seconds here to match every other timestamp this app threads
// through, e.g. SeaDrop's own on-chain startTime/endTime).
test('getDrop normalizes a real-shaped response: active/next stage, full stage list, wei price kept as a string', async () => {
  const http = { get: async url => {
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'cool-cats' } };
    if (url.endsWith('/drops/cool-cats')) return { data: {
      is_minting: true, drop_type: 'seadrop_v1_erc721', max_supply: '10000', opensea_url: 'https://opensea.io/collection/cool-cats',
      active_stage: { uuid: 'a1', label: 'Public sale', start_time: '2026-08-19T18:00:00Z', end_time: '2026-08-26T18:00:00Z', price: '50000000000000000', price_currency_address: '0x0000000000000000000000000000000000000000', stage_type: 'public_sale', max_per_wallet: '5' },
      next_stage: null,
      stages: [
        { uuid: 'a0', label: 'Allowlist', start_time: '2026-08-18T18:00:00Z', end_time: '2026-08-19T18:00:00Z', price: '0', price_currency_address: '0x0000000000000000000000000000000000000000', stage_type: 'presale', max_per_wallet: '2' },
        { uuid: 'a1', label: 'Public sale', start_time: '2026-08-19T18:00:00Z', end_time: '2026-08-26T18:00:00Z', price: '50000000000000000', price_currency_address: '0x0000000000000000000000000000000000000000', stage_type: 'public_sale', max_per_wallet: '5' },
      ],
    } };
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const drop = await service.getDrop('ethereum', CONTRACT);
  assert.equal(drop.isMinting, true);
  assert.equal(drop.dropType, 'seadrop_v1_erc721');
  assert.equal(drop.maxSupply, 10000);
  assert.equal(drop.openSeaUrl, 'https://opensea.io/collection/cool-cats');
  assert.equal(drop.activeStage.label, 'Public sale');
  assert.equal(drop.activeStage.priceWei, '50000000000000000');
  assert.equal(drop.activeStage.maxPerWallet, 5);
  assert.equal(drop.activeStage.startTime, Math.floor(Date.parse('2026-08-19T18:00:00Z') / 1000));
  assert.equal(drop.nextStage, null);
  assert.equal(drop.stages.length, 2);
  assert.equal(drop.stages[0].label, 'Allowlist');
  assert.equal(drop.stages[0].priceWei, '0');
});

test('getDrop surfaces a future stage as nextStage when the drop is not currently minting', async () => {
  const http = { get: async url => {
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'cool-cats' } };
    if (url.endsWith('/drops/cool-cats')) return { data: {
      is_minting: false, drop_type: 'seadrop_v1_erc721', max_supply: '10000', opensea_url: null,
      active_stage: null,
      next_stage: { uuid: 'a1', label: 'Public sale', start_time: '2026-08-20T18:00:00Z', end_time: '2026-08-27T18:00:00Z', price: '50000000000000000', price_currency_address: '0x0000000000000000000000000000000000000000', stage_type: 'public_sale', max_per_wallet: '5' },
      stages: [],
    } };
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const drop = await service.getDrop('ethereum', CONTRACT);
  assert.equal(drop.isMinting, false);
  assert.equal(drop.activeStage, null);
  assert.equal(drop.nextStage.label, 'Public sale');
  assert.equal(drop.nextStage.startTime, Math.floor(Date.parse('2026-08-20T18:00:00Z') / 1000));
});

test('getDrop returns null (never throws) when unconfigured, unsupported, not a drop, or the API fails', async () => {
  const noKey = createOpenSeaService({ apiKey: null, repository: fakeRepository(), http: { get: async () => { throw new Error('should not be called'); } } });
  assert.equal(await noKey.getDrop('ethereum', CONTRACT), null);

  const unsupportedChain = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => { throw new Error('should not be called'); } } });
  assert.equal(await unsupportedChain.getDrop('not-a-real-chain', CONTRACT), null);

  const noSlug = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async () => ({ data: {} }) } });
  assert.equal(await noSlug.getDrop('ethereum', CONTRACT), null);

  // A plain, non-OpenSea-drop contract 404s -- exactly this shape of failure, not a special case.
  const notADrop = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http: { get: async url => {
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'plain-collection' } };
    throw new Error('404');
  } } });
  assert.equal(await notADrop.getDrop('ethereum', CONTRACT), null);
});

test('getCollectionStats tolerates a stats response missing some fields, filling in null rather than throwing', async () => {
  const http = { get: async url => {
    if (url.includes('/chain/ethereum/contract/')) return { data: { collection: 'partial-collection' } };
    if (url.endsWith('/collections/partial-collection/stats')) return { data: { total: { floor_price: 0.5 } } };
    throw new Error(`unexpected url ${url}`);
  } };
  const service = createOpenSeaService({ apiKey: 'test-key', repository: fakeRepository(), http });
  const stats = await service.getCollectionStats('ethereum', CONTRACT);
  assert.equal(stats.floorPrice, 0.5);
  assert.equal(stats.numOwners, null);
  assert.deepEqual(stats.volume, { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null });
});
