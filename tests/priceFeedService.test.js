const assert = require('node:assert/strict');
const test = require('node:test');
const { createPriceFeedService } = require('../src/mint/priceFeedService');

test('fetches and returns the USD price for a mapped symbol', async () => {
  const http = { get: async (url, options) => {
    assert.equal(options.params.ids, 'ethereum');
    assert.equal(options.params.include_last_updated_at, 'true');
    return { data: { ethereum: { usd: 3200.5 } } };
  } };
  const service = createPriceFeedService({ http });
  assert.equal(await service.getUsdPrice('ETH'), 3200.5);
});

test('maps Polygon POL to its live CoinGecko asset and is case-insensitive', async () => {
  const calls = [];
  const http = { get: async (url, options) => { calls.push(options.params.ids); return { data: { 'polygon-ecosystem-token': { usd: 0.5 } } }; } };
  const service = createPriceFeedService({ http });
  assert.equal(await service.getUsdPrice('pol'), 0.5);
  assert.deepEqual(calls, ['polygon-ecosystem-token']);
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

test('returns a timestamped NGN quote and supports the HyperEVM native token', async () => {
  const calls=[];
  const http={get:async(_url,options)=>{calls.push(options.params);return {
    data:{hyperliquid:{ngn:145000,last_updated_at:123456}},
  };}};
  const service=createPriceFeedService({http,now:()=>123456000});
  assert.deepEqual(await service.getFiatQuote('hype','ngn'),{
    symbol:'HYPE',currency:'NGN',rate:145000,quotedAt:123456000,receivedAt:123456000,
    stale:false,source:'coingecko',
  });
  assert.deepEqual(calls,[{ids:'hyperliquid',vs_currencies:'ngn',include_last_updated_at:'true'}]);
});

test('marks a cached quote stale when refresh fails and never invents unsupported rates',async()=>{
  let now=100_000;let fail=false;
  const http={get:async()=>{if(fail)throw new Error('offline');return {data:{ethereum:{eur:2500,last_updated_at:100}}};}};
  const service=createPriceFeedService({http,now:()=>now,ttlMs:10});
  const fresh=await service.getFiatQuote('ETH','EUR');
  assert.equal(fresh.stale,false);
  now=101_000;fail=true;
  const stale=await service.getFiatQuote('ETH','EUR');
  assert.equal(stale.rate,2500);
  assert.equal(stale.stale,true);
  assert.equal(await service.getFiatQuote('ETH','JPY'),null);
  assert.equal(await service.getFiatQuote('SOL','USD'),null);
});

test('an old or timestamp-less provider quote is displayable but never marked current',async()=>{
  const now=2_000_000;
  const old=createPriceFeedService({now:()=>now,http:{get:async()=>({
    data:{ethereum:{usd:3000,last_updated_at:1}},
  })}});
  assert.equal((await old.getFiatQuote('ETH','USD')).stale,true);
  const missing=createPriceFeedService({now:()=>now,http:{get:async()=>({data:{ethereum:{usd:3000}}})}});
  assert.equal((await missing.getFiatQuote('ETH','USD')).stale,true);
});

test('recomputes provider age when serving a cached quote inside the response TTL',async()=>{
  let now=1_000_000;let calls=0;
  const service=createPriceFeedService({now:()=>now,ttlMs:30*60_000,maxProviderAgeMs:10*60_000,
    http:{get:async()=>{calls+=1;return {data:{ethereum:{usd:3000,last_updated_at:1000}}};}}});
  assert.equal((await service.getFiatQuote('ETH','USD')).stale,false);
  now+=11*60_000;
  assert.equal((await service.getFiatQuote('ETH','USD')).stale,true);
  assert.equal(calls,1,'provider response TTL should still avoid a second request');
});

test('rejects provider timestamps beyond the allowed future clock skew',async()=>{
  const now=1_000_000;
  const beyond=createPriceFeedService({now:()=>now,futureClockSkewToleranceMs:60_000,
    http:{get:async()=>({data:{ethereum:{usd:3000,last_updated_at:(now+60_001)/1000}}})}});
  assert.equal((await beyond.getFiatQuote('ETH','USD')).stale,true);

  const within=createPriceFeedService({now:()=>now,futureClockSkewToleranceMs:60_000,
    http:{get:async()=>({data:{ethereum:{usd:3000,last_updated_at:(now+60_000)/1000}}})}});
  assert.equal((await within.getFiatQuote('ETH','USD')).stale,false);
});

test('concurrent cold reads share one provider request',async()=>{
  let calls=0;let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const service=createPriceFeedService({now:()=>1_000_000,http:{get:async()=>{
    calls+=1;await wait;return {data:{ethereum:{usd:3000,last_updated_at:1000}}};
  }}});
  const first=service.getFiatQuote('ETH','USD');
  const second=service.getFiatQuote('ETH','USD');
  release();
  await Promise.all([first,second]);
  assert.equal(calls,1);
});
