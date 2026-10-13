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

test('wallet history runtime is inert by default even when a repository exists', () => {
  const runtime = createWalletHistoryRuntime({ repository:repository(), supportedChains:['ethereum'] });
  assert.deepEqual(runtime.providerRegistry.list(), []);
  assert.equal(runtime.worker, null);
  assert.deepEqual(runtime.health(), {
    status:'disabled', running:false, active:false, providerConfigured:false,
    detail:'wallet history worker is not enabled',
  });
});

test('an explicitly enabled adapter is selectable without implicitly starting a worker', () => {
  const runtime = createWalletHistoryRuntime({
    repository:repository(),
    supportedChains:['ethereum'],
    goldRush:{ enabled:true, apiKey:'test-key', chains:['ethereum'] },
    fetchImpl:async () => { throw new Error('must not fetch during construction'); },
  });
  assert.deepEqual(runtime.providerRegistry.list().map(item => [item.chain, item.providerKey]), [
    ['ethereum', 'goldrush'],
  ]);
  assert.equal(runtime.worker, null);
  assert.equal(runtime.health().providerConfigured, true);
});

test('the worker exists only behind its separate explicit gate', () => {
  const runtime = createWalletHistoryRuntime({
    repository:repository(),
    supportedChains:['ethereum'],
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
});
