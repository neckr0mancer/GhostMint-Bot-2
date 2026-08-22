const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { STAGE_NOT_OPEN, STAGE_NOT_OPEN_MAX_ATTEMPTS, STAGE_NOT_OPEN_RETRY_MS, createSchedulerWorker,
  errorReason, isTransientFailure } = require('../src/scheduler/schedulerWorker');

function task(overrides = {}) {
  return {
    id:'11111111-1111-4111-8111-111111111111', userId:'22222222-2222-4222-8222-222222222222',
    name:'scheduled mint', attemptCount:1, maxAttempts:3, idempotencyKey:'scheduled-mint:test',
    transactionIntentId:null, ...overrides,
  };
}

function repositoryFixture(stale = [], { imminent = [] } = {}) {
  const calls = [];
  return {
    calls,
    async listStaleClaims() { return stale; },
    async attachIntent(value, intentId) { calls.push(['attach', intentId]); },
    async complete(value, intentId) { calls.push(['complete', intentId]); },
    async recoverWithoutExecution(value, details) { calls.push(['recover', details]); },
    // Records the task as a third element too: the stage-not-open path raises maxAttempts on the
    // object it hands the repository, and that is the only place the widened budget is observable.
    async fail(value, details) { calls.push(['fail', details, value]); return details.transient ? 'retry' : 'failed'; },
    async claimDue() { calls.push(['claimDue']); return null; },
    async listImminent() { return imminent; },
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
