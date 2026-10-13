const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GOLDRUSH_CHAIN_SLUGS,
  GoldRushWalletHistoryError,
  createGoldRushWalletHistoryAdapter,
} = require('../src/walletHistory/goldRushAdapter');
const { createWalletHistoryProviderRegistry } = require('../src/walletHistory/provider');

const WALLET = '0x00000000000000000000000000000000000000a7';
const OTHER = '0x00000000000000000000000000000000000000b8';
const NFT = '0x00000000000000000000000000000000000000c9';
const TX_HASH = `0x${'12'.repeat(32)}`;
const BLOCK_HASH = `0x${'34'.repeat(32)}`;

function response(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers:{ get:name => headers[String(name).toLowerCase()] ?? null },
    json:async () => body,
  };
}

function transaction(overrides = {}) {
  return {
    block_signed_at:'2026-10-13T12:30:00Z',
    block_height:100,
    block_hash:BLOCK_HASH,
    tx_hash:TX_HASH,
    tx_offset:2,
    successful:true,
    from_address:WALLET,
    to_address:OTHER,
    value:'25',
    gas_offered:21000,
    gas_spent:20000,
    gas_price:100,
    fees_paid:'2000000',
    value_quote:0.01,
    gas_quote:0.001,
    explorers:[{ label:'Explorer', url:`https://example.test/tx/${TX_HASH}` }],
    internal_transfers:[{ from_address:OTHER, to_address:WALLET, value:'3', gas_limit:5000 }],
    log_events:[{
      log_offset:7,
      sender_address:NFT,
      sender_name:'Collection',
      sender_contract_ticker_symbol:'NFT',
      sender_contract_decimals:0,
      supports_erc:['erc721'],
      decoded:{ name:'Transfer', signature:'Transfer(address,address,uint256)', params:[
        { name:'from', value:'0x0000000000000000000000000000000000000000' },
        { name:'to', value:WALLET },
        { name:'tokenId', value:'42' },
      ] },
    }],
    ...overrides,
  };
}

test('maps every current GhostMint chain to the documented GoldRush REST slug', () => {
  assert.deepEqual(GOLDRUSH_CHAIN_SLUGS, {
    ethereum:'eth-mainnet', base:'base-mainnet', arbitrum:'arbitrum-mainnet',
    polygon:'matic-mainnet', ink:'ink-mainnet', robinhood:'robinhood-mainnet',
    hyperevm:'hyperevm-mainnet',
  });
});

test('normalizes a GoldRush page through the provider contract without inventing calldata', async () => {
  let captured;
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key',
    baseUrl:'https://history.example/v1',
    fetchImpl:async (url, options) => {
      captured={ url:String(url), options };
      return response({ error:false, data:{ current_page:0, chain_tip_height:120,
        links:{ prev:null, next:'https://history.example/next' }, items:[transaction()] } });
    },
  });
  const registry = createWalletHistoryProviderRegistry({ adapters:[adapter] });
  const page = await registry.fetchPage({ chain:'ethereum', walletAddress:WALLET });

  assert.match(captured.url, /\/eth-mainnet\/address\/0x[0-9a-f]{40}\/transactions_v3\/page\/0\//);
  assert.match(captured.url, /block-signed-at-asc=true/);
  assert.doesNotMatch(captured.url, /with-internal/);
  assert.equal(captured.options.headers.authorization, 'Bearer private-test-key');
  assert.deepEqual(page.nextCursor, { page:1 });
  assert.equal(page.transactions[0].input, null);
  assert.equal(page.transactions[0].nonce, null);
  assert.equal(page.transactions[0].executionStatus, 'success');
  assert.equal(page.transactions[0].finalityStatus, 'unfinalized');
  assert.equal(page.transactions[0].rawSummary.calldataAvailable, false);
  assert.deepEqual(page.transactions[0].movements.map(item => item.eventType),
    ['native_transfer', 'fee', 'mint']);
  const minted = page.transactions[0].movements.at(-1);
  assert.equal(minted.assetStandard, 'erc721');
  assert.equal(minted.tokenId, '42');
  assert.equal(minted.direction, 'in');
  assert.equal(page.coverage.history, null);
  assert.equal(page.recheckRange, null);
});

test('does not request undocumented internal transfers or infer completeness from a final page', async () => {
  let requestedUrl;
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key', chains:['ink'], baseUrl:'https://history.example/v1/',
    fetchImpl:async url => {
      requestedUrl=String(url);
      return response({ data:{ current_page:3, chain_tip_height:'900',
        links:{ prev:'previous', next:null }, items:[] }, error:false });
    },
  });
  const page = await adapter.fetchPage({ chain:'ink', walletAddress:WALLET,
    cursor:{ page:3 }, fromBlock:null, throughBlock:null });
  assert.match(requestedUrl, /\/ink-mainnet\//);
  assert.doesNotMatch(requestedUrl, /with-internal/);
  assert.equal(page.hasMore, false);
  assert.equal(page.coverage.history, null);
  assert.equal(page.recheckRange, null);
});

test('keeps only wallet-involved movements and skips malformed or custom transfer logs', async () => {
  const custom = { log_offset:3, sender_address:NFT, supports_erc:[], decoded:{
    name:'Transfer', params:[{ name:'from', value:'not-an-address' }],
  } };
  const malformed = { log_offset:4, sender_address:NFT, supports_erc:['erc20'], decoded:{
    name:'Transfer', params:[{ name:'src', value:'not-an-address' },
      { name:'dst', value:WALLET }, { name:'wad', value:'99' }],
  } };
  const tracked = { log_offset:5, sender_address:NFT, supports_erc:['erc20'], decoded:{
    name:'Transfer', params:[{ name:'src', value:OTHER },
      { name:'dst', value:WALLET }, { name:'wad', value:'5' }],
  } };
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key', baseUrl:'https://history.example/v1',
    fetchImpl:async () => response({ data:{ current_page:0, chain_tip_height:120,
      links:{ next:null }, items:[transaction({
        from_address:OTHER, to_address:NFT, value:'25', fees_paid:'50',
        internal_transfers:[{ from_address:OTHER, to_address:WALLET, value:'3' }],
        log_events:[custom, malformed, tracked],
      })] } }),
  });
  const registry = createWalletHistoryProviderRegistry({ adapters:[adapter] });
  const page = await registry.fetchPage({ chain:'ethereum', walletAddress:WALLET });
  assert.deepEqual(page.transactions[0].movements.map(item => ({
    type:item.eventType, direction:item.direction, amount:item.amountRaw,
  })), [{ type:'erc20_transfer', direction:'in', amount:'5' }]);
});

test('rejects stale cursors, wrong pages, block ranges, and unsafe provider integers', async () => {
  const replies = [
    { data:{ current_page:4, chain_tip_height:100, links:{ next:null }, items:[] } },
    { data:{ current_page:0, chain_tip_height:Number.MAX_SAFE_INTEGER + 1,
      links:{ next:null }, items:[] } },
  ];
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key', baseUrl:'https://history.example/v1',
    fetchImpl:async () => response(replies.shift()),
  });
  const base = { chain:'ethereum', walletAddress:WALLET, fromBlock:null, throughBlock:null };
  await assert.rejects(adapter.fetchPage({ ...base, cursor:{ page:-1 } }), error =>
    error instanceof GoldRushWalletHistoryError && error.code === 'GOLDRUSH_CURSOR_INVALID');
  await assert.rejects(adapter.fetchPage({ ...base, cursor:{ page:0, ignored:true } }), error =>
    error instanceof GoldRushWalletHistoryError && error.code === 'GOLDRUSH_CURSOR_INVALID');
  await assert.rejects(adapter.fetchPage({ ...base, cursor:null, fromBlock:'1' }), error =>
    error instanceof GoldRushWalletHistoryError && error.code === 'GOLDRUSH_RANGE_UNSUPPORTED');
  await assert.rejects(adapter.fetchPage({ ...base, cursor:null }), error =>
    error instanceof GoldRushWalletHistoryError && error.code === 'GOLDRUSH_RESPONSE_INVALID');
  await assert.rejects(adapter.fetchPage({ ...base, cursor:null }), error =>
    error instanceof GoldRushWalletHistoryError && /unsafe chain tip height/.test(error.message));
});

test('rejects missing or malformed pagination instead of falsely declaring history complete', async () => {
  const replies = [
    { data:{ current_page:0, chain_tip_height:100, items:[] } },
    { data:{ current_page:0, chain_tip_height:100, links:{ next:'' }, items:[] } },
  ];
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'  private-test-key  ', baseUrl:'https://history.example/v1',
    fetchImpl:async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer private-test-key');
      return response(replies.shift());
    },
  });
  const request = { chain:'ethereum', walletAddress:WALLET, cursor:null,
    fromBlock:null, throughBlock:null };
  await assert.rejects(adapter.fetchPage(request), error =>
    error.code === 'GOLDRUSH_RESPONSE_INVALID');
  await assert.rejects(adapter.fetchPage(request), error =>
    error.code === 'GOLDRUSH_RESPONSE_INVALID');
});

test('requires an explicit array of supported configured chains', () => {
  assert.throws(() => createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key', chains:'ethereum', fetchImpl:async () => response({}),
  }), /chains must be an array/);
});

test('classifies provider authorization and rate-limit failures without exposing response bodies', async () => {
  const replies = [
    response({ secret:'must-not-appear' }, { ok:false, status:401 }),
    response({ secret:'must-not-appear' }, { ok:false, status:429, headers:{ 'retry-after':'7' } }),
  ];
  const adapter = createGoldRushWalletHistoryAdapter({
    apiKey:'private-test-key', baseUrl:'https://history.example/v1',
    fetchImpl:async () => replies.shift(),
  });
  const request = { chain:'ethereum', walletAddress:WALLET, cursor:null,
    fromBlock:null, throughBlock:null };
  await assert.rejects(adapter.fetchPage(request), error =>
    error.code === 'GOLDRUSH_AUTH_FAILED' && !error.message.includes('must-not-appear'));
  await assert.rejects(adapter.fetchPage(request), error =>
    error.code === 'GOLDRUSH_RATE_LIMITED' && error.retryAfterMs === 7000
      && !error.message.includes('must-not-appear'));
});
