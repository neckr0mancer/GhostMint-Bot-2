const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalletHistoryWorker } = require('../src/walletHistory/worker');

const claim = Object.freeze({
  userId:'user-a', chain:'ethereum',
  walletAddress:'0x00000000000000000000000000000000000000a7',
  providerKey:'goldrush', generation:4, cursor:{page:2}, claimedBy:'worker-a',
});

function fixture({ claims = [claim], runSyncPage = async () => ({state:'backfilling'}) } = {}) {
  const calls = [];
  const queue = [...claims];
  const repository = {
    claimDue:async input => { calls.push(['claim',input]); return queue.shift() || null; },
    releaseClaim:async input => { calls.push(['release',input]); return null; },
  };
  const service = {
    runSyncPage:async (...args) => { calls.push(['run',...args]); return runSyncPage(...args); },
  };
  return { calls, repository, service };
}

test('processes at most one leased page per tick and forwards the lease owner', async () => {
  const { calls,repository,service } = fixture({ claims:[claim,claim] });
  const worker = createWalletHistoryWorker({ repository,service,workerId:'Worker-A',
    now:()=>5_000,leaseMs:30_000 });
  assert.equal(await worker.tick(), true);
  assert.equal(calls.filter(call => call[0] === 'claim').length, 1);
  const run = calls.find(call => call[0] === 'run');
  assert.equal(run[1], 'user-a');
  assert.deepEqual(run[2], { address:claim.walletAddress,chain:'ethereum' });
  assert.deepEqual(run[3], { chain:'ethereum',providerKey:'goldrush',workerId:'worker-a' });
  assert.equal(worker.health().lastError, null);
});

test('coalesces overlapping ticks so a process cannot claim twice concurrently', async () => {
  let finish;
  const gate = new Promise(resolve => { finish=resolve; });
  const { calls,repository,service } = fixture({ runSyncPage:async () => gate });
  const worker = createWalletHistoryWorker({ repository,service,workerId:'worker-a' });
  const first = worker.tick();
  const second = worker.tick();
  assert.equal(first, second);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'claim').length, 1);
  finish({state:'partial'});
  assert.equal(await first, true);
});

test('records a safe failure and only releases its own surviving claim', async () => {
  const secret = 'ab'.repeat(32);
  const logs = [];
  const { calls,repository,service } = fixture({ runSyncPage:async () => {
    throw new Error(`temporary failure\n${secret}`);
  } });
  const worker = createWalletHistoryWorker({ repository,service,workerId:'worker-a',
    log:value=>logs.push(value) });
  assert.equal(await worker.tick(), false);
  const release = calls.find(call => call[0] === 'release')[1];
  assert.deepEqual(release, { userId:'user-a',chain:'ethereum',
    walletAddress:claim.walletAddress,workerId:'worker-a' });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /\n/);
  assert.doesNotMatch(logs[0], new RegExp(secret));
  assert.match(logs[0], /REDACTED_PRIVATE_KEY/);
  assert.match(worker.health().lastError, /temporary failure/);
});

test('reports stopped/running health and waits for an active tick during stop', async () => {
  const { repository,service } = fixture({ claims:[] });
  const worker = createWalletHistoryWorker({ repository,service,workerId:'worker-a',
    intervalMs:60_000 });
  assert.equal(worker.health().status, 'stopped');
  worker.start();
  assert.equal(worker.health().running, true);
  await worker.stop();
  assert.equal(worker.health().status, 'stopped');
  assert.equal(worker.health().running, false);
});
