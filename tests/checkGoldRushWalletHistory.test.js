'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  checkGoldRushWalletHistory,
  configuredChains,
  printResult,
  startupProbeEnabled,
} = require('../scripts/check-goldrush-wallet-history');

function response(body, { status = 200 } = {}) {
  return {
    ok:status >= 200 && status < 300,
    status,
    headers:{ get:() => null },
    json:async() => body,
  };
}

test('skips without a configured key and never calls the network', async () => {
  let called = false;
  const result = await checkGoldRushWalletHistory({ apiKey:'', chains:['ethereum'],
    fetchImpl:async() => { called = true; } });
  assert.deepEqual(result, {
    skipped:true,
    reason:'GOLDRUSH_API_KEY is not configured',
    results:[],
  });
  assert.equal(called, false);
});

test('checks supported chains through the strict provider contract and reports unsupported chains', async () => {
  const urls = [];
  const result = await checkGoldRushWalletHistory({
    apiKey:'test-key',
    chains:['ethereum','sepolia'],
    fetchImpl:async(url, options) => {
      urls.push(String(url));
      assert.equal(options.headers.authorization, 'Bearer test-key');
      return response({ data:{ current_page:0, chain_tip_height:123, items:[], links:{ next:null } } });
    },
  });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.results, [
    { chain:'ethereum', ok:true, transactions:0, hasMore:false, observedHeadBlock:'123' },
    { chain:'sepolia', ok:false, code:'GOLDRUSH_CHAIN_UNSUPPORTED', status:null },
  ]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /eth-mainnet/);
});

test('sanitizes provider failures and printed output never contains the key or response body', async () => {
  const secret = 'must-not-appear';
  const result = await checkGoldRushWalletHistory({
    apiKey:secret,
    chains:['base'],
    fetchImpl:async() => response({ error:true, error_message:`bad ${secret}` }, { status:401 }),
  });
  const output = [];
  printResult(result, line => output.push(line));
  assert.deepEqual(result.results, [
    { chain:'base', ok:false, code:'GOLDRUSH_AUTH_FAILED', status:401 },
  ]);
  assert.doesNotMatch(output.join('\n'), /must-not-appear|error_message/);
  assert.match(output.join('\n'), /0\/1 chain\(s\) passed/);
});

test('normalizes and deduplicates configured chain names', () => {
  assert.deepEqual(configuredChains(' Ethereum,base,ethereum, robinhood '),
    ['ethereum','base','robinhood']);
});

test('startup probing is fail-closed and requires an explicit true flag', () => {
  assert.equal(startupProbeEnabled({}), false);
  assert.equal(startupProbeEnabled({ GOLDRUSH_HISTORY_PROBE_ON_STARTUP:'false' }), false);
  assert.equal(startupProbeEnabled({ GOLDRUSH_HISTORY_PROBE_ON_STARTUP:'1' }), false);
  assert.equal(startupProbeEnabled({ GOLDRUSH_HISTORY_PROBE_ON_STARTUP:' TRUE ' }), true);
});
