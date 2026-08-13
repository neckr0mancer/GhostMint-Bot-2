const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { createSchedulerWorker, isTransientFailure } = require('../src/scheduler/schedulerWorker');

function task(overrides = {}) {
  return {
    id:'11111111-1111-4111-8111-111111111111', userId:'22222222-2222-4222-8222-222222222222',
    name:'scheduled mint', attemptCount:1, maxAttempts:3, idempotencyKey:'scheduled-mint:test',
    transactionIntentId:null, ...overrides,
  };
}

function repositoryFixture(stale = []) {
  const calls = [];
  return {
    calls,
    async listStaleClaims() { return stale; },
    async attachIntent(value, intentId) { calls.push(['attach', intentId]); },
    async complete(value, intentId) { calls.push(['complete', intentId]); },
    async recoverWithoutExecution(value, details) { calls.push(['recover', details]); },
    async fail(value, details) { calls.push(['fail', details]); return details.transient ? 'retry' : 'failed'; },
    async claimDue() { return null; },
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
