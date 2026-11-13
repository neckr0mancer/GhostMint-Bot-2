'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalletHistoryRuntime } = require('../src/walletHistory/runtime');

function repository() {
  return {
    claimDue:async () => null,
    releaseClaim:async () => false,
  };
}

function providerService() {
  return {
    expectedChainId:() => 1,
    perform:async () => { throw new Error('must not call RPC during construction'); },
  };
}

test('wallet history runtime is inert by default even when a repository exists', () => {
  const runtime = createWalletHistoryRuntime({ repository:repository(), supportedChains:['ethereum'] });
  assert.deepEqual(runtime.providerRegistry.list(), []);
  assert.equal(runtime.worker, null);
  assert.deepEqual(runtime.health(), {
    status:'disabled', running:false, active:false, providerConfigured:false,
    detail:'wallet history worker is not enabled',
  });
});

test('an explicitly enabled adapter is selectable without implicitly starting a worker', async () => {
  const runtime = createWalletHistoryRuntime({
    repository:repository(),
    supportedChains:['ethereum'],
    providerService:providerService(),
    goldRush:{ enabled:true, apiKey:'test-key', chains:['ethereum'] },
    fetchImpl:async () => { throw new Error('must not fetch during construction'); },
  });
  assert.deepEqual(runtime.providerRegistry.list().map(item => [item.chain, item.providerKey]), [
    ['ethereum', 'goldrush'],
  ]);
  assert.equal(runtime.worker, null);
  assert.equal(runtime.health().providerConfigured, true);
  assert.deepEqual(await runtime.service.requestSync('user-a',{
    chain:'ethereum',address:'0x0000000000000000000000000000000000000001',
  }),{
    accepted:false,supported:false,state:'disabled',
    message:'Wallet history sync is not enabled on this server.',
  });
});

test('the enabled runtime exposes only RPC-finalized canonical GoldRush rows', async () => {
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const finalizedHash = `0x${'12'.repeat(32)}`;
  const recentHash = `0x${'34'.repeat(32)}`;
  const blocks = new Map([
    ['0x64', { number:100, hash:`0x${'56'.repeat(32)}` }],
    ['0x65', { number:101, hash:`0x${'78'.repeat(32)}` }],
  ]);
  const runtime = createWalletHistoryRuntime({
    repository:repository(),
    supportedChains:['ethereum'],
    providerService:{
      expectedChainId:() => 1,
      perform:async (_chain, _operation, callback) => callback({
        getNetwork:async () => ({ chainId:1 }),
        getBlock:async block => block === 'finalized'
          ? { number:100, hash:`0x${'9a'.repeat(32)}` }
          : blocks.get(block),
      }),
    },
    goldRush:{ enabled:true, apiKey:'test-key', chains:['ethereum'] },
    fetchImpl:async () => ({
      ok:true,
      headers:{ get:() => null },
      json:async () => ({ data:{
        current_page:0,
        chain_tip_height:120,
        links:{ next:'https://history.example/next' },
        items:[
          {
            block_signed_at:'2026-10-17T00:00:00Z', block_height:100,
            block_hash:`0x${'56'.repeat(32)}`, tx_hash:finalizedHash, tx_offset:0,
            successful:true, from_address:walletAddress,
            to_address:'0x0000000000000000000000000000000000000002', value:'0',
            gas_offered:21000, gas_spent:21000, gas_price:1, fees_paid:'21000',
            internal_transfers:[], log_events:[],
          },
          {
            block_signed_at:'2026-10-17T00:01:00Z', block_height:101,
            block_hash:`0x${'78'.repeat(32)}`, tx_hash:recentHash, tx_offset:0,
            successful:true, from_address:walletAddress,
            to_address:'0x0000000000000000000000000000000000000002', value:'0',
            gas_offered:21000, gas_spent:21000, gas_price:1, fees_paid:'21000',
            internal_transfers:[], log_events:[],
          },
        ],
      } }),
    }),
  });
  const page = await runtime.providerRegistry.fetchPage({
    chain:'ethereum', walletAddress,
  });
  assert.deepEqual(page.transactions.map(item => item.txHash), [finalizedHash]);
  assert.deepEqual(page.nextCursor, { page:1 });
  assert.equal(page.finalizedThroughBlock, '100');
  assert.deepEqual(page.coverage, { history:null, provenance:null });
  assert.equal(page.recheckRange, null);
});

test('the worker exists only behind its separate explicit gate', () => {
  const runtime = createWalletHistoryRuntime({
    repository:repository(),
    supportedChains:['ethereum'],
    providerService:providerService(),
    goldRush:{ enabled:true, apiKey:'test-key', chains:['ethereum'] },
    worker:{ enabled:true, intervalMs:15000, leaseMs:90000 },
    fetchImpl:async () => { throw new Error('must not fetch during construction'); },
  });
  assert.ok(runtime.worker);
  assert.equal(runtime.worker.health().status, 'stopped');
  assert.equal(runtime.worker.health().running, false);
});

test('runtime rejects inconsistent provider and worker gates', () => {
  assert.throws(() => createWalletHistoryRuntime({
    repository:repository(), supportedChains:['ethereum'], worker:{ enabled:true },
  }), /requires an enabled provider adapter/);
  assert.throws(() => createWalletHistoryRuntime({
    repository:repository(), supportedChains:['ethereum'], goldRush:{ enabled:true, chains:['ethereum'] },
  }), /requires an API key/);
  assert.throws(() => createWalletHistoryRuntime({
    repository:repository(), supportedChains:['ethereum'], goldRush:{ enabled:true, apiKey:'test-key' },
  }), /requires at least one chain/);
  assert.throws(() => createWalletHistoryRuntime({
    repository:repository(), supportedChains:['ethereum'],
    goldRush:{ enabled:true, apiKey:'test-key', chains:['ethereum'] },
  }), /requires RPC finality verification/);
});
