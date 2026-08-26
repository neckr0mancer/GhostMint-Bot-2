const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { SCHEDULE_PHASE_WAIT, STAGE_NOT_OPEN, STAGE_NOT_OPEN_MAX_ATTEMPTS, STAGE_NOT_OPEN_RETRY_MS,
  STAGE_REARM_MAX_ATTEMPTS, STAGE_REARM_WINDOW_MS, createSchedulerWorker,
  errorReason, executionAttemptCount, isTransientFailure } = require('../src/scheduler/schedulerWorker');

function task(overrides = {}) {
  return {
    id:'11111111-1111-4111-8111-111111111111', userId:'22222222-2222-4222-8222-222222222222',
    name:'scheduled mint', attemptCount:1, maxAttempts:3, idempotencyKey:'scheduled-mint:test',
    transactionIntentId:null, ...overrides,
  };
}

function repositoryFixture(stale = [], { imminent = [] } = {}) {
  const calls = [];
  // Live box so tests can move the imminent set between scans (the pre-arm tests re-arm against a
  // moved mintTime); every pre-existing caller just reads it through listImminent as before.
  const state = { imminent };
  return {
    calls,
    state,
    async listStaleClaims() { return stale; },
    async attachIntent(value, intentId) { calls.push(['attach', intentId]); },
    async complete(value, intentId) { calls.push(['complete', intentId]); },
    async recoverWithoutExecution(value, details) { calls.push(['recover', details]); },
    // Records the task as a third element too: the stage-not-open path raises maxAttempts on the
    // object it hands the repository, and that is the only place the widened budget is observable.
    // Mirrors schedulerRepository.fail's real rule -- retry only while the budget holds. Without
    // the attemptCount check this returned 'retry' for anything transient, which cannot express an
    // exhausted budget at all, so a test for "gives up" could never fail honestly.
    async fail(value, details) { calls.push(['fail', details, value]);
      return details.transient && executionAttemptCount(value) < value.maxAttempts ? 'retry' : 'failed'; },
    async claimDue() { calls.push(['claimDue']); return null; },
    async listImminent() { return state.imminent; },
  };
}

test('stale claimed task is reconciled from chain state without executing again', async () => {
  const stale = task({ transactionIntentId:'intent-1' });
  const repository = repositoryFixture([stale]);
  let executions = 0;
  let reconciliations = 0;
  const worker = createSchedulerWorker({
    repository,
    intentRepository: { get:async () => ({ intentId:'intent-1', state:'pending' }), getByIdempotencyKey:async () => null },
    transactionEngine: { reconcileIntent:async intent => { reconciliations += 1; return { ...intent, state:'confirmed' }; } },
    executeTask:async () => { executions += 1; },
  });

  assert.equal(await worker.recoverStaleClaims(), 1);
  assert.equal(reconciliations, 1, 'recovery must consult transaction state');
  assert.equal(executions, 0, 'recovery must not blindly execute again');
  assert.deepEqual(repository.calls.at(-1), ['complete', 'intent-1']);
});

test('recovery retry transitions notify listeners after the durable retry state is saved', async () => {
  const repository = repositoryFixture();
  const events = [];
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async()=>({intentId:'intent-pending',state:'pending'}),getByIdempotencyKey:async()=>null },
    transactionEngine:{ reconcileIntent:async intent=>intent },
    executeTask:async()=>{throw new Error('must not execute during recovery');},
    notify:async event=>events.push(event),
  });
  assert.equal(await worker.processTask(task({transactionIntentId:'intent-pending'}),true),'retry');
  assert.equal(repository.calls.some(call=>call[0]==='recover'&&call[1].status==='retry'),true);
  assert.equal(events.length,1);
  assert.equal(events[0].outcome,'retry');
  assert.equal(events[0].recovery,true);
});

test('a reverted intent preserves its exact chain failure reason for the task and notification', async () => {
  const repository = repositoryFixture();
  const events = [];
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{
      get:async()=>({ intentId:'intent-sold-out', state:'reverted', failureReason:'This mint is sold out.' }),
      getByIdempotencyKey:async()=>null,
    },
    transactionEngine:{},
    executeTask:async()=>{ throw new Error('must not execute an existing intent'); },
    notify:async event=>events.push(event),
  });

  assert.equal(await worker.processTask(task({ transactionIntentId:'intent-sold-out' })), 'failed');
  const recovered = repository.calls.find(call=>call[0]==='recover');
  assert.equal(recovered[1].reason, 'This mint is sold out.');
  assert.equal(events[0].reason, 'This mint is sold out.');
  assert.equal(events[0].intent.failureReason, 'This mint is sold out.');
});

test('a failed recovery-refresh notification cannot change the persisted retry outcome', async () => {
  const repository = repositoryFixture();
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{get:async()=>null,getByIdempotencyKey:async()=>null},transactionEngine:{},
    executeTask:async()=>{throw new Error('must not execute during recovery');},
    notify:async()=>{throw new Error('dashboard unavailable');},
  });
  assert.equal(await worker.processTask(task(),true),'retry');
  assert.equal(repository.calls.some(call=>call[0]==='recover'&&call[1].status==='retry'),true);
});

test('an idempotency-key intent prevents duplicate task execution', async () => {
  const repository = repositoryFixture();
  let executions = 0;
  const worker = createSchedulerWorker({
    repository,
    intentRepository: {
      get:async () => null,
      getByIdempotencyKey:async () => ({ intentId:'intent-existing', state:'confirmed' }),
    },
    transactionEngine: { reconcileIntent:async intent => intent },
    executeTask:async () => { executions += 1; },
  });
  await worker.processTask(task());
  await worker.processTask(task());
  assert.equal(executions, 0);
  assert.equal(repository.calls.filter(call => call[0] === 'complete').length, 2);
});

test('transient failures retry within bounds and permanent failures do not retry', async () => {
  const transientRepository = repositoryFixture();
  const transient = Object.assign(new Error('RPC unavailable'), { code:'RPC_UNAVAILABLE' });
  const transientWorker = createSchedulerWorker({
    repository:transientRepository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{}, executeTask:async () => { throw transient; }, now:() => 1_000, retryBaseMs:100,
  });
  assert.equal(await transientWorker.processTask(task()), 'retry');
  assert.equal(transientRepository.calls.at(-1)[1].transient, true);
  assert.equal(transientRepository.calls.at(-1)[1].retryAt, 1_100);

  const permanentRepository = repositoryFixture();
  const permanentWorker = createSchedulerWorker({
    repository:permanentRepository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{}, executeTask:async () => { throw new ValidationError({ field:'contractAddress', message:'is invalid' }); },
  });
  assert.equal(await permanentWorker.processTask(task()), 'failed');
  assert.equal(permanentRepository.calls.at(-1)[1].transient, false);
  assert.equal(isTransientFailure(new ValidationError({ field:'quantity', message:'is invalid' })), false);
});

test('waiting for a live eligible phase durably re-arms without spending the execution retry budget', async () => {
  const repository = repositoryFixture();
  repository.deferForPhase = async (value, details) => {
    repository.calls.push(['deferForPhase', details, value]);
    return { ...value, status:'retry', mintTime:details.mintTime ?? value.mintTime, nextAttemptAt:details.retryAt,
      stageUuid:details.stageUuid, attemptCount:value.attemptCount,
      phaseWaitCount:(value.phaseWaitCount||0)+1 };
  };
  const retryAt = 9_000;
  const wait = Object.assign(new Error('Waiting for the Public phase to go live.'), {
    code:SCHEDULE_PHASE_WAIT,
    phaseDeferral:{ retryAt, stageUuid:'public-stage', stageLabel:'Public', stageType:'public_sale' },
  });
  const events = [];
  let executed = false;
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{}, preflightTask:async () => { throw wait; },
    executeTask:async () => { executed = true; throw new Error('must not execute while waiting'); },
    notify:async event => events.push(event),
  });

  assert.equal(await worker.processTask(task({ attemptCount:9, maxAttempts:1 })), 'retry');
  const deferred = repository.calls.find(call => call[0] === 'deferForPhase');
  assert.equal(deferred[1].retryAt, retryAt);
  assert.equal(deferred[1].stageUuid, 'public-stage');
  assert.equal(repository.calls.some(call => call[0] === 'fail'), false,
    'phase waiting must not pass through maxAttempts-based failure handling');
  assert.equal(executed, false);
  assert.deepEqual(events.map(event => event.outcome), ['retry'],
    'waiting must not emit a misleading starting notification');
  assert.equal(events.at(-1).phaseWait, true);
  assert.equal(events.at(-1).task.stageUuid, 'public-stage');
});

test('many phase checks still leave the first real RPC failure on the first retry delay', async () => {
  const repository = repositoryFixture();
  const transient = Object.assign(new Error('RPC unavailable'), { code:'RPC_UNAVAILABLE' });
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async()=>null, getByIdempotencyKey:async()=>null },
    transactionEngine:{}, executeTask:async()=>{ throw transient; }, now:()=>1_000, retryBaseMs:100,
  });
  const waited = task({ attemptCount:21, phaseWaitCount:20, maxAttempts:3 });
  assert.equal(await worker.processTask(waited), 'retry');
  const failed = repository.calls.find(call=>call[0]==='fail');
  assert.equal(failed[1].retryAt, 1_100);
});

test('start keeps sweeping for claims whose lease expires after process startup', async () => {
  let sweeps = 0;
  const repository = repositoryFixture();
  repository.listStaleClaims = async () => { sweeps += 1; return []; };
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async()=>null, getByIdempotencyKey:async()=>null },
    transactionEngine:{}, executeTask:async()=>null,
    pollIntervalMs:1_000, staleRecoveryIntervalMs:10,
  });
  worker.start();
  await new Promise(resolve=>setTimeout(resolve, 35));
  worker.stop();
  assert.ok(sweeps >= 2, 'stale claims must be revisited after their lease can expire');
});

test('notification failure cannot change a confirmed task outcome', async () => {
  const repository = repositoryFixture();
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{ reconcileIntent:async intent => intent },
    executeTask:async () => ({ intentId:'intent-2', state:'confirmed' }),
    notify:async () => { throw new Error('Telegram unavailable'); },
  });
  assert.equal(await worker.processTask(task()), 'succeeded');
  assert.deepEqual(repository.calls.at(-1), ['complete', 'intent-2']);
});

test('a due task announces that execution is starting before it broadcasts', async () => {
  const repository = repositoryFixture();
  const order = [];
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{ reconcileIntent:async intent => intent },
    executeTask:async () => { order.push('execute'); return { intentId:'intent-start', state:'confirmed' }; },
    notify:async event => order.push(event.outcome),
  });

  assert.equal(await worker.processTask(task()), 'succeeded');
  assert.deepEqual(order, ['starting', 'execute', 'success']);
});

test('a failed start notification cannot prevent automatic execution', async () => {
  const repository = repositoryFixture();
  let executed = false;
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{ reconcileIntent:async intent => intent },
    executeTask:async () => { executed = true; return { intentId:'intent-start-failure', state:'confirmed' }; },
    notify:async event => { if (event.outcome === 'starting') throw new Error('all notification transports unavailable'); },
  });

  assert.equal(await worker.processTask(task()), 'succeeded');
  assert.equal(executed, true);
});

test('Round 16 (Section AV, item 4): precise timers fire tick() the instant a lookahead task becomes due, without waiting for the next poll interval', async t => {
  await t.test('an imminent task gets a precise setTimeout that calls tick() at its exact due time', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 20 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
    });
    // start() is never called here, so the only way claimDue() could be reached at all is the
    // precise timer armPreciseTimers() sets -- there is no interval loop running in this test.
    await worker.armPreciseTimers();
    assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, 0, 'must not claim before the due time arrives');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(repository.calls.filter(c => c[0] === 'claimDue').length >= 1, 'the precise timer must have called tick() -> claimDue() on its own');
  });

  await t.test('arming the same task twice only ever schedules one timer for it', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 10_000 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
    });
    await worker.armPreciseTimers();
    await worker.armPreciseTimers();
    assert.equal(worker.health().armedCount, 1, 're-arming an already-armed task must be a no-op');
    worker.stop();
  });

  await t.test('stop() clears every armed timer -- none of them fire afterward', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 20 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
    });
    await worker.armPreciseTimers();
    worker.stop();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, 0, 'a cleared timer must never fire');
  });

  await t.test('a task outside the lookahead window is left for the ordinary poll loop, not armed', async () => {
    const repository = repositoryFixture([], { imminent: [] });
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
    });
    await worker.armPreciseTimers();
    assert.equal(worker.health().armedCount, 0);
  });
});

test('Round 16 (Section AV, item A3): pre-arm timers run the preparation hook ahead of the fire moment', async t => {
  await t.test('a configured prearm hook fires once per task at fire-moment-minus-lead, without claiming anything', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 60, mintTime: Date.now() + 60 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const prearmed = [];
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
      prearmLeadMs: 30,
      prearm: async value => { prearmed.push(value.id); },
    });
    // The scan window widens to cover the lead, so a single armPreciseTimers() call arms both
    // timers; start() is never called and claimDue() is only ever reached by the fire timer.
    await worker.armPreciseTimers();
    assert.equal(worker.health().prearmedCount, 1, 'the preparation timer must be armed');
    assert.equal(prearmed.length, 0, 'preparation must not run before its lead moment');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(prearmed, [imminentTask.id], 'the pre-arm hook must have run by lead time');
    assert.equal(repository.calls.filter(c => c[0] === 'claimDue').length, 0, 'preparation must not claim or mutate task state');
    worker.stop();
  });

  await t.test('a moved mintTime replaces the old preparation timer instead of double-firing', async () => {
    const original = Date.now() + 5_000;
    const imminentTask = task({ nextAttemptAt: original, mintTime: original });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const prearmed = [];
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
      prearmLeadMs: 4_900,
      prearm: async value => { prearmed.push(value.mintTime); },
    });
    await worker.armPreciseTimers();
    const moved = Date.now() + 40;
    repository.state.imminent = [{ ...imminentTask, nextAttemptAt: moved, mintTime: moved }];
    await worker.armPreciseTimers();
    assert.equal(worker.health().prearmedCount, 1, 'the replacement must not stack on top of the old timer');
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.deepEqual(prearmed, [moved], 'only the re-armed firing may prepare');
    worker.stop();
  });

  await t.test('a throwing prearm hook is logged and forgotten -- it can never break the fire path', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 60 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const logged = [];
    let calls = 0;
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
      prearmLeadMs: 30,
      prearm: async () => { calls += 1; throw new Error('preparation exploded'); },
      log: message => logged.push(message),
    });
    await worker.armPreciseTimers();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(calls, 1);
    assert.ok(logged.some(message => /pre-arm failed/i.test(message)), 'the failure must be traced');
    worker.stop();
  });

  await t.test('no prearm options means no preparation machinery runs at all (zero behavior change)', async () => {
    const imminentTask = task({ nextAttemptAt: Date.now() + 10_000 });
    const repository = repositoryFixture([], { imminent: [imminentTask] });
    const worker = createSchedulerWorker({
      repository, intentRepository: { get: async () => null, getByIdempotencyKey: async () => null },
      transactionEngine: {}, executeTask: async () => ({ intentId: 'x', state: 'confirmed' }),
    });
    await worker.armPreciseTimers();
    assert.equal(worker.health().prearmedCount, 0);
    worker.stop();
  });
});

// Live-reported: scheduled mints failing with a Telegram/Discord notification reading only
// "Request validation failed", and the stored last_error saying the same -- for four genuinely
// different causes. Every ValidationError carries that one constant as its Error message, so
// neither the user nor a later investigation could tell which check rejected the mint. The reason
// string is the only diagnostic that survives (deployment logs are purged once a deploy is
// replaced), so it has to carry the issue itself.
test('a permanent validation failure records which check rejected the mint, not just that one did', async () => {
  const repository = repositoryFixture();
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{},
    executeTask:async () => { throw new ValidationError({ field:'calldata', message:'does not match the SeaDrop mintPublic signature' }); },
  });

  assert.equal(await worker.processTask(task()), 'failed');
  const details = repository.calls.at(-1)[1];
  assert.equal(details.transient, false, 'a validation failure is still permanent');
  assert.match(details.reason, /calldata does not match the SeaDrop mintPublic signature/,
    'the failing check must survive into the reason the user and the database both see');
});

test('errorReason folds in every validation issue and leaves other errors untouched', () => {
  const many = new ValidationError([
    { field:'quantity', message:'is invalid' },
    { field:'chain', message:'is not supported' },
  ]);
  assert.equal(errorReason(many), 'Request validation failed: quantity is invalid; chain is not supported');
  // Non-validation errors already carried a useful message and must not be reshaped.
  assert.equal(errorReason(Object.assign(new Error('RPC unavailable'), { code:'RPC_UNAVAILABLE' })), 'RPC unavailable');
  assert.equal(errorReason(undefined), 'Unknown scheduler failure');
  // A ValidationError with no usable issues must still degrade to the plain message.
  const empty = new ValidationError([]);
  empty.issues = [];
  assert.equal(errorReason(empty), 'Request validation failed');
});

// Live-reported: a phase schedule fired, OpenSea answered 409 "Drop is not currently active for
// minting", and the task failed permanently and expired an hour later without ever retrying. A
// stage rarely flips active at exactly its advertised second, so the request was early rather than
// wrong -- the identical call succeeds once the stage opens.
test('a stage that has not opened yet retries on a tight fixed interval instead of failing permanently', async () => {
  const repository = repositoryFixture();
  const notOpen = new ValidationError({ field:'contractAddress', message:'Drop is not currently active for minting' }, STAGE_NOT_OPEN);
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{}, executeTask:async () => { throw notOpen; },
    now:() => 1_000, retryBaseMs:5_000,
  });

  assert.equal(await worker.processTask(task()), 'retry', 'an unopened stage must not fail permanently');
  const [, details, handed] = repository.calls.at(-1);
  assert.equal(details.transient, true);
  assert.equal(details.retryAt, 1_000 + STAGE_NOT_OPEN_RETRY_MS,
    'retries one second out, not on the exponential backoff meant for congestion');
  assert.equal(handed.maxAttempts, STAGE_NOT_OPEN_MAX_ATTEMPTS,
    "the widened budget must reach the repository, since that is where retry-vs-fail is decided");
});

test('the widened stage budget is a ceiling, and never shrinks a task that already allows more', async () => {
  const repository = repositoryFixture();
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{},
    executeTask:async () => { throw new ValidationError({ field:'contractAddress', message:'not active' }, STAGE_NOT_OPEN); },
    now:() => 1_000,
  });

  await worker.processTask(task({ maxAttempts: 12 }));
  assert.equal(repository.calls.at(-1)[2].maxAttempts, 12, 'a task configured with more attempts keeps them');
});

test('an ordinary validation failure stays permanent and keeps the exponential backoff for real transients', async () => {
  assert.equal(isTransientFailure(new ValidationError({ field:'quantity', message:'is invalid' })), false,
    'a malformed request stays malformed -- only the stage-not-open code is exempt');
  assert.equal(isTransientFailure(new ValidationError({ field:'contractAddress', message:'not active' }, STAGE_NOT_OPEN)), true);

  // A genuine transient must still back off exponentially rather than inheriting the 1s interval.
  const repository = repositoryFixture();
  const worker = createSchedulerWorker({
    repository,
    intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
    transactionEngine:{},
    executeTask:async () => { throw Object.assign(new Error('RPC unavailable'), { code:'RPC_UNAVAILABLE' }); },
    now:() => 1_000, retryBaseMs:100,
  });
  await worker.processTask(task({ attemptCount: 3 }));
  assert.equal(repository.calls.at(-1)[1].retryAt, 1_000 + 400, 'exponential backoff is unchanged');
  assert.equal(repository.calls.at(-1)[2].maxAttempts, 3, 'and its budget is untouched');
});

// The reported task fired well outside its stage's window and burned. The owner confirmed the phase
// itself was not moved, so the stored time was wrong rather than stale -- which is the same recovery
// either way: read the stage's real opening from OpenSea and re-arm to it, once.
function stageWaitWorker(repository, { resolveStageStart, now = () => 1_000, mintTime = 1_000 } = {}) {
  return {
    worker: createSchedulerWorker({
      repository,
      intentRepository:{ get:async () => null, getByIdempotencyKey:async () => null },
      transactionEngine:{},
      executeTask:async () => { throw new ValidationError({ field:'contractAddress', message:'not active' }, STAGE_NOT_OPEN); },
      now, resolveStageStart,
    }),
    spent: task({ attemptCount: STAGE_NOT_OPEN_MAX_ATTEMPTS, mintTime }),
  };
}

test('once the retry burst is spent, the task re-arms to the stage\'s real opening time', async () => {
  const repository = repositoryFixture();
  const reopensAt = 1_000 + 90_000;
  const { worker, spent } = stageWaitWorker(repository, { resolveStageStart: async () => reopensAt });

  assert.equal(await worker.processTask(spent), 'retry', 'a resolvable opening must not be discarded');
  const [, details, handed] = repository.calls.at(-1);
  assert.equal(details.retryAt, reopensAt, 'it waits for the real opening, not another one-second tick');
  assert.equal(handed.maxAttempts, STAGE_REARM_MAX_ATTEMPTS, 'the re-arm grants a second burst at the new time');
});

test('the re-arm happens at most once, and never consults the schedule again afterwards', async () => {
  const repository = repositoryFixture();
  let lookups = 0;
  const { worker } = stageWaitWorker(repository, { resolveStageStart: async () => { lookups += 1; return 1_000 + 90_000; } });

  // An attempt past the first burst is by definition already re-armed.
  await worker.processTask(task({ attemptCount: STAGE_NOT_OPEN_MAX_ATTEMPTS + 1, mintTime: 1_000 }));
  assert.equal(lookups, 0, 'a second lookup would mean a task could chase a stage indefinitely');
  assert.equal(repository.calls.at(-1)[1].retryAt, 1_000 + STAGE_NOT_OPEN_RETRY_MS, 'back to the tight burst');
  assert.equal(repository.calls.at(-1)[2].maxAttempts, STAGE_REARM_MAX_ATTEMPTS);
});

test('an opening beyond the fixed window, or none at all, fails instead of re-arming', async () => {
  const beyond = repositoryFixture();
  const { worker: farWorker, spent: farTask } = stageWaitWorker(beyond, {
    resolveStageStart: async () => 1_000 + STAGE_REARM_WINDOW_MS + 60_000,
  });
  assert.equal(await farWorker.processTask(farTask), 'failed', 'a stage a day-plus out is not worth holding a task for');

  const none = repositoryFixture();
  const { worker: noneWorker, spent: noneTask } = stageWaitWorker(none, { resolveStageStart: async () => null });
  assert.equal(await noneWorker.processTask(noneTask), 'failed');

  // A lookup that throws must degrade to the ordinary outcome, never escape processTask.
  const broken = repositoryFixture();
  const { worker: brokenWorker, spent: brokenTask } = stageWaitWorker(broken, {
    resolveStageStart: async () => { throw new Error('OpenSea unreachable'); },
  });
  assert.equal(await brokenWorker.processTask(brokenTask), 'failed');
});
