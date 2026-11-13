'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WalletHistoryFinalityError,
  createRpcFinalityVerifier,
} = require('../src/walletHistory/rpcFinalityVerifier');

const HASH_90 = `0x${'5a'.repeat(32)}`;
const HASH_100 = `0x${'64'.repeat(32)}`;
const HASH_101 = `0x${'65'.repeat(32)}`;

function transaction(blockNumber, blockHash) {
  return { txHash:`0x${String(blockNumber).padStart(64, '0')}`,
    blockNumber:String(blockNumber), blockHash, finalityStatus:'unfinalized', canonical:true };
}

function service({ chainId = 1n, finalized = 100,
  hashes = { 90:HASH_90, 101:HASH_101 } } = {}) {
  const calls = [];
  return {
    calls,
    expectedChainId:() => 1,
    perform:async (chain, operation, callback, options) => {
      calls.push({ chain, operation, options });
      return callback({
        getNetwork:async () => ({ chainId }),
        getBlock:async tag => {
          if (tag === 'finalized') return { number:finalized, hash:HASH_100 };
          const number = Number(BigInt(tag));
          return hashes[number] ? { number, hash:hashes[number] } : null;
        },
      });
    },
  };
}

test('marks only RPC-canonical transactions at or below the finalized head', async () => {
  const providerService = service();
  const verifier = createRpcFinalityVerifier({ providerService });
  const result = await verifier.verifyPage({
    chain:'ethereum',
    observedHeadBlock:'101',
    transactions:[transaction(90, HASH_90), transaction(101, HASH_101)],
  });

  assert.equal(result.finalizedThroughBlock, '100');
  assert.deepEqual(result.transactions.map(item => item.finalityStatus),
    ['finalized', 'unfinalized']);
  assert.deepEqual(providerService.calls, [{
    chain:'ethereum', operation:'walletHistoryFinalityPage', options:{ retries:0 },
  }]);
});

test('caps finality at the provider-observed head', async () => {
  const providerService = service({ finalized:100, hashes:{ 90:HASH_90 } });
  const result = await createRpcFinalityVerifier({ providerService }).verifyPage({
    chain:'ethereum', observedHeadBlock:'90', transactions:[transaction(90, HASH_90)],
  });
  assert.equal(result.finalizedThroughBlock, '90');
  assert.equal(result.transactions[0].finalityStatus, 'finalized');
});

test('fails closed on the wrong chain or a finalized canonical hash mismatch', async () => {
  await assert.rejects(createRpcFinalityVerifier({
    providerService:service({ chainId:8453n }),
  }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[transaction(90, HASH_90)],
  }), error => error instanceof WalletHistoryFinalityError
    && error.code === 'WALLET_HISTORY_CHAIN_MISMATCH');

  await assert.rejects(createRpcFinalityVerifier({
    providerService:service({ hashes:{ 90:HASH_101 } }),
  }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[transaction(90, HASH_90)],
  }), error => error instanceof WalletHistoryFinalityError
    && error.code === 'WALLET_HISTORY_CANONICALITY_MISMATCH');
});

test('rejects missing finality configuration and invalid RPC responses', async () => {
  const unsupported = service();
  unsupported.expectedChainId = () => null;
  await assert.rejects(createRpcFinalityVerifier({ providerService:unsupported }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[],
  }), error => error.code === 'WALLET_HISTORY_CHAIN_UNSUPPORTED');

  const invalid = service();
  invalid.perform = async (_chain, operation, callback) => callback({
    getNetwork:async () => ({ chainId:1n }),
    getBlock:async tag => tag === 'finalized' ? { number:null, hash:HASH_100 } : null,
  });
  await assert.rejects(createRpcFinalityVerifier({ providerService:invalid }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[],
  }), error => error.code === 'WALLET_HISTORY_FINALITY_INVALID');
});

test('rejects malformed or oversized provider pages before making any RPC call', async () => {
  const cases = [
    { observedHeadBlock:100, transactions:[] },
    { observedHeadBlock:'01', transactions:[] },
    { observedHeadBlock:'9223372036854775808', transactions:[] },
    { observedHeadBlock:'100', transactions:[transaction(101, HASH_101)] },
    { observedHeadBlock:'100', transactions:[transaction(90, '0x01')] },
    { observedHeadBlock:'100', transactions:[
      transaction(90, HASH_90), transaction(90, HASH_101),
    ] },
    { observedHeadBlock:'100', transactions:[
      { ...transaction(90, HASH_90), canonical:false },
    ] },
    { observedHeadBlock:'100', transactions:Array.from({ length:101 }, () =>
      transaction(90, HASH_90)) },
  ];

  for (const input of cases) {
    const providerService = service();
    await assert.rejects(createRpcFinalityVerifier({ providerService }).verifyPage({
      chain:'ethereum', ...input,
    }), error => error instanceof WalletHistoryFinalityError);
    assert.equal(providerService.calls.length, 0);
  }
});

test('validates the complete page observation after the page-scoped RPC callback returns', async () => {
  const providerService = service({ chainId:8453n });
  await assert.rejects(createRpcFinalityVerifier({ providerService }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[transaction(90, HASH_90)],
  }), error => error.code === 'WALLET_HISTORY_CHAIN_MISMATCH');
  assert.equal(providerService.calls.length, 1);

  const unavailable = service({ hashes:{} });
  await assert.rejects(createRpcFinalityVerifier({ providerService:unavailable }).verifyPage({
    chain:'ethereum', observedHeadBlock:'100', transactions:[transaction(90, HASH_90)],
  }), error => error.code === 'WALLET_HISTORY_FINALITY_UNAVAILABLE');
  assert.equal(unavailable.calls.length, 1);
});
