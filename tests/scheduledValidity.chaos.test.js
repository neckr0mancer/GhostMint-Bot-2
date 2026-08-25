// REG-002 -- deterministic chaos tests for the delayed-mint path (INNOV-001/TX-006).
// The advertised time T is treated as imperfect; the contract opens at T+offset. Every scenario
// below is driven by a controllable clock and a scripted executeTask -- no sleeps, no real RPC,
// no flaky timing. Offsets 1s/3s/7s cover inside-the-burst, at-the-burst-edge, and past-the-burst
// (re-arm territory) so all three rescue mechanisms are exercised.
const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { STAGE_NOT_OPEN, STAGE_NOT_OPEN_MAX_ATTEMPTS, STAGE_REARM_MAX_ATTEMPTS,
  createSchedulerWorker } = require('../src/scheduler/schedulerWorker');

const T = 1_800_000_000_000; // advertised wall-clock fire moment

function chaosRepository() {
  const calls = [];
  return {
    calls,
    async attachIntent() { calls.push(['attach']); },
    async complete(_t, intentId) { calls.push(['complete', intentId]); },
    async recoverWithoutExecution(_t, details) { calls.push(['recover', details]); },
    async fail(value, details) {
      calls.push(['fail', details, value]);
      return details.transient && value.attemptCount < value.maxAttempts ? 'retry' : 'failed';
    },
    async claimDue() { calls.push(['claimDue']); return null; },
    async listImminent() { return []; },
    async listStaleClaims() { return []; },
  };
}

// A worker whose contract opens `delayMs` after T and whose RPC is up/up-down per the script.
function chaosWorker({ repository, now, behavior, resolveStageStart = null }) {
  let calls = 0;
  const executions = [];
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
    transactionEngine: {},
    executeTask: async () => {
      calls += 1;
      executions.push(now());
      return behavior(now(), calls);
    },
    now,
    retryBaseMs: 100,
    resolveStageStart,
  });
  return { worker, executions };
}

const notOpenYet = realOpenSec => Object.assign(
  new ValidationError({ field: 'mintTime', message: `This mint has not opened yet (opens ${new Date(realOpenSec * 1000).toISOString()}).` }),
  { code: STAGE_NOT_OPEN });

test('delayed open at T+1s: one transient burst attempt, then success the moment the window is real', async () => {
  const repository = chaosRepository();
  let nowMs = T;
  const { worker, executions } = chaosWorker({
    repository,
    now: () => nowMs,
    behavior: () => (nowMs < T + 1000 ? (() => { throw notOpenYet((T + 1000) / 1000); })() : { intentId: 'intent-1', state: 'confirmed' }),
  });
  const t = task => ({ ...task, attemptCount: 1, maxAttempts: 3, chain: 'ethereum' });

  // T+0: fails transient, retry 250ms out -- never permanent.
  assert.equal(await worker.processTask(t()), 'retry');
  assert.equal(repository.calls.at(-1)[0], 'fail');
  assert.equal(repository.calls.at(-1)[1].transient, true);
  assert.equal(repository.calls.at(-1)[1].retryAt, T + 250);

  // T+1.1s: window real -- succeeds on the very next attempt.
  nowMs = T + 1100;
  assert.equal(await worker.processTask(t()), 'succeeded');
  assert.deepEqual(executions, [T, T + 1100], 'exactly two executions: one early discovery, one valid mint');
  assert.equal(repository.calls.at(-1)[0], 'complete');
});

test('delayed open at T+3s and T+7s: the burst never turns a not-open-yet into a permanent failure', async () => {
  for (const delayMs of [3000, 7000]) {
    const repository = chaosRepository();
    let nowMs = T;
    let attempt = 0;
    const { worker } = chaosWorker({
      repository,
      now: () => nowMs,
      behavior: () => {
        attempt += 1;
        if (nowMs < T + delayMs) throw notOpenYet((T + delayMs) / 1000);
        return { intentId: 'intent-ok', state: 'confirmed' };
      },
      // The shipped on-chain oracle (13fce24): after the burst, the contract itself is asked when
      // it really opens and the task re-arms to that moment with a fresh budget.
      resolveStageStart: async () => T + delayMs,
    });
    const t = () => ({ id: 't-delay', userId: 'u', attemptCount: attempt, maxAttempts: 3, chain: 'ethereum', idempotencyKey: 'k' });
    // Faithful clock: after each attempt the scheduler sleeps until retryAt -- burst steps are
    // +250ms, a contract-told re-arm jumps straight to the real opening. No 250ms polling past a
    // re-arm: that would model a bot that ignores its own schedule.
    let succeeded = false;
    for (let guard = 0; guard < 40; guard += 1) {
      const t2 = t();
      t2.attemptCount = attempt; // the real repository increments per claim
      const outcome = await worker.processTask(t2);
      if (outcome === 'succeeded') { succeeded = true; break; }
      assert.equal(outcome, 'retry', `attempt at T+${nowMs - T}ms must stay transient for a ${delayMs}ms delay`);
      const recorded = repository.calls.at(-1)[1].retryAt;
      assert.ok(recorded === nowMs + 250 || recorded === T + delayMs,
        `retryAt must be a burst step (T+${nowMs - T + 250}ms) or the contract-told opening, got T+${recorded - T}ms`);
      nowMs = Math.max(recorded, nowMs + 1);
    }
    assert.ok(succeeded, `mints once the window is real (T+${delayMs}ms)`);
    assert.ok(attempt <= STAGE_REARM_MAX_ATTEMPTS + 2, 'the two-budget design bounds total attempts');
  }
});

test('RPC disconnect mid-window is transient too: the burst survives an outage between T and the open', async () => {
  const repository = chaosRepository();
  let nowMs = T;
  let attempt = 0;
  let rpcDown = true;
  const { worker } = chaosWorker({
    repository,
    now: () => nowMs,
    behavior: () => {
      attempt += 1;
      if (rpcDown) throw Object.assign(new Error('All RPC providers failed'), { code: 'RPC_UNAVAILABLE' });
      if (nowMs < T + 3000) throw notOpenYet((T + 3000) / 1000);
      return { intentId: 'intent-ok', state: 'confirmed' };
    },
  });
  const t = () => ({ id: 't-rpc', userId: 'u', attemptCount: attempt, maxAttempts: 3, chain: 'ethereum', idempotencyKey: 'k' });
  // RPC down at T+250ms: transient, not permanent.
  nowMs = T + 250;
  assert.equal(await worker.processTask(t()), 'retry');
  assert.equal(repository.calls.at(-1)[1].transient, true);
  // RPC recovers, contract still closed at T+500ms: still transient.
  rpcDown = false;
  nowMs = T + 500;
  assert.equal(await worker.processTask(t()), 'retry');
  // Window opens at T+3s: succeeds.
  nowMs = T + 3000;
  assert.equal(await worker.processTask(t()), 'succeeded');
});

test('duplicate block events cannot double-claim: handleBlock is one-shot per stage-not-open failure', async () => {
  const repository = chaosRepository();
  let nowMs = T;
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
    transactionEngine: {},
    executeTask: async () => { throw notOpenYet(T / 1000 + 5); },
    now: () => nowMs,
  });
  const t = { id: 't-blocks', userId: 'u', attemptCount: 1, maxAttempts: 3, chain: 'ethereum', idempotencyKey: 'k' };
  await worker.processTask(t);
  const claimsAfterFailure = repository.calls.filter(c => c[0] === 'claimDue').length;

  // First block after the failure: the registered chain gets exactly one tick.
  worker.handleBlock('ethereum');
  assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, claimsAfterFailure + 1);
  // Duplicate delivery of the same block (reconnect replay): no second tick.
  worker.handleBlock('ethereum');
  assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, claimsAfterFailure + 1,
    'a duplicate block event must not claim twice');
  // A chain that never had a waiting task: no tick either.
  worker.handleBlock('base');
  assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, claimsAfterFailure + 1);
});

test('the block-retry registration feeds the watcher wiring (onStageNotOpen) exactly per failure', async () => {
  const repository = chaosRepository();
  const watched = [];
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
    transactionEngine: {},
    executeTask: async () => { throw notOpenYet(T / 1000 + 5); },
    now: () => nowMs,
    onStageNotOpen: chain => watched.push(chain),
  });
  let nowMs = T;
  const t = { id: 't-watch', userId: 'u', attemptCount: 1, maxAttempts: 3, chain: 'robinhood', idempotencyKey: 'k' };
  await worker.processTask(t);
  assert.deepEqual(watched, ['robinhood'], 'the watcher wiring learns the chain once per failure');
  await worker.processTask(t);
  assert.deepEqual(watched, ['robinhood', 'robinhood'], 'a second failure re-asserts the watcher (idempotent upstream)');
});

test('restart during the armed window: a fresh worker re-claims and the burst budget still holds', async () => {
  const repository = chaosRepository();
  let nowMs = T;
  let attempt = 0;
  const { worker: first } = chaosWorker({
    repository,
    now: () => nowMs,
    behavior: () => { attempt += 1; throw notOpenYet((T + 5000) / 1000); },
  });
  // Pre-restart attempts (the process dies after two of them).
  const t = () => ({ id: 't-restart', userId: 'u', attemptCount: attempt, maxAttempts: 3, chain: 'ethereum', idempotencyKey: 'k' });
  nowMs = T + 250; await first.processTask(t());
  nowMs = T + 500; await first.processTask(t());
  const failsBefore = repository.calls.filter(c => c[0] === 'fail').length;

  // "Restart": a brand-new worker instance over the same repository and clock.
  const { worker: second } = chaosWorker({
    repository,
    now: () => nowMs,
    behavior: () => { attempt += 1; throw notOpenYet((T + 5000) / 1000); },
  });
  nowMs = T + 750;
  assert.equal(await second.processTask(t()), 'retry', 'the restarted worker continues the transient burst');
  assert.equal(repository.calls.filter(c => c[0] === 'fail').length, failsBefore + 1);
  assert.ok(repository.calls.at(-1)[2].attemptCount >= 1, 'attempt history survives the restart via the repository');
});

test('burst exhaustion re-arms to the contract-told opening (the on-chain getPublicDrop answer)', async () => {
  const repository = chaosRepository();
  let nowMs = T;
  const realOpen = T + 7000;
  let attempt = 0;
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
    transactionEngine: {},
    executeTask: async () => { attempt += 1; throw notOpenYet(realOpen / 1000); },
    now: () => nowMs,
    // The on-chain oracle: the same source the drift preflight reads.
    resolveStageStart: async () => realOpen,
  });
  // Burn the burst: attempts 1..STAGE_NOT_OPEN_MAX_ATTEMPTS, 250ms apart.
  for (let i = 1; i <= STAGE_NOT_OPEN_MAX_ATTEMPTS; i += 1) {
    const t = { id: 't-rearm', userId: 'u', attemptCount: i, maxAttempts: 3, chain: 'ethereum', idempotencyKey: 'k' };
    nowMs += 250;
    const outcome = await worker.processTask(t);
    if (i < STAGE_NOT_OPEN_MAX_ATTEMPTS) {
      assert.equal(outcome, 'retry', `burst attempt ${i} stays transient`);
      assert.equal(repository.calls.at(-1)[1].retryAt, nowMs + 250);
    } else {
      // The budget is spent: the oracle's answer becomes the re-arm moment, with a fresh budget.
      assert.equal(outcome, 'retry', 'a contract-told opening re-arms instead of failing');
      assert.equal(repository.calls.at(-1)[1].retryAt, realOpen,
        're-arms to exactly the opening the contract reported, not another blind 250ms');
      assert.equal(repository.calls.at(-1)[2].maxAttempts, STAGE_REARM_MAX_ATTEMPTS, 'the re-arm grants a second burst');
    }
  }
});

test('a permanent validation failure inside the burst still fails without retry (eligibility is not timing)', async () => {
  const repository = chaosRepository();
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
    transactionEngine: {},
    // OpenSea's own eligibility answer for a signed-presale stage the wallet is not on.
    executeTask: async () => { throw new ValidationError({ field: 'contractAddress', message: 'this wallet is not eligible for this stage' }); },
    now: () => T,
  });
  assert.equal(await worker.processTask({ id: 't-elig', userId: 'u', attemptCount: 1, maxAttempts: 3, chain: 'robinhood', idempotencyKey: 'k' }), 'failed');
  assert.equal(repository.calls.at(-1)[1].transient, false, 'eligibility is permanent -- retrying cannot fix an allowlist');
  assert.equal(repository.calls.at(-1)[1].retryAt, null);
});
