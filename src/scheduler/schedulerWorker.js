const { randomUUID } = require('node:crypto');
const { ValidationError } = require('../validation/domain');
const { TransactionSafetyError } = require('../transactions/transactionEngine');

const TRANSIENT_CODES = new Set(['RPC_UNAVAILABLE', 'BROADCAST_UNKNOWN', 'NETWORK_ERROR', 'SERVER_ERROR',
  'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);
const FINAL_TRANSACTION_STATES = new Set(['confirmed', 'reverted', 'replaced']);

function errorReason(error) {
  return String(error?.message || 'Unknown scheduler failure').slice(0, 500);
}

function isTransientFailure(error) {
  if (error instanceof ValidationError) return false;
  if (error instanceof TransactionSafetyError) return TRANSIENT_CODES.has(error.code);
  return TRANSIENT_CODES.has(error?.code);
}

function createSchedulerWorker({ repository, intentRepository, transactionEngine, executeTask,
  workerId = randomUUID(), now = () => Date.now(), leaseMs = 120_000,
  pollIntervalMs = 1_000, retryBaseMs = 5_000, notify, log = () => {}, sanitizeError = errorReason,
  // A single in-flight task used to serialize every scheduled mint behind whichever one claimed
  // first, even though processTask() waits for full on-chain finality (up to policy's
  // transactionTimeoutMs, 10 minutes by default) before returning -- a second task whose own
  // mint_time had already arrived sat unclaimed the entire time. Raising this from the old
  // single-slot guard to a small pool lets independent due tasks run concurrently; each `tick()`
  // call still fully awaits its own claimed task (unchanged -- see dashboard.test.js's
  // `await worker.tick()` expectation), so this only changes how many overlapping `tick()` calls
  // the existing setInterval loop is allowed to have outstanding at once.
  maxConcurrentTasks = 5 }) {
  let timer = null;
  let inFlightCount = 0;
  let lastTickAt=null;let lastSuccessAt=null;let lastError=null;

  function retryAt(attemptCount) {
    return now() + retryBaseMs * (2 ** Math.max(0, attemptCount - 1));
  }

  async function settleFromIntent(task, intent, recovery) {
    let current = intent;
    if (!FINAL_TRANSACTION_STATES.has(current.state)) current = await transactionEngine.reconcileIntent(current);
    await repository.attachIntent(task, current.intentId);
    if (current.state === 'confirmed') {
      await repository.complete(task, current.intentId, recovery ? 'recovered from confirmed transaction intent' : 'transaction confirmed');
      await Promise.resolve(notify?.({ task, outcome: 'success', intent: current })).catch(() => {});
      return 'succeeded';
    }
    if (['reverted', 'replaced'].includes(current.state)) {
      await repository.recoverWithoutExecution(task, { status: 'failed', intentId: current.intentId,
        reason: `transaction ${current.state}` });
      await Promise.resolve(notify?.({ task, outcome: 'failure', intent: current })).catch(() => {});
      return 'failed';
    }
    await repository.recoverWithoutExecution(task, { status: 'retry', intentId: current.intentId,
      retryAt: retryAt(task.attemptCount), reason: `transaction remains ${current.state}; reconciliation will continue` });
    return 'retry';
  }

  async function existingIntent(task) {
    if (task.transactionIntentId) {
      const linked = await intentRepository.get(task.transactionIntentId);
      if (linked) return linked;
    }
    return intentRepository.getByIdempotencyKey(task.idempotencyKey);
  }

  async function processTask(task, recovery = false) {
    try {
      const existing = await existingIntent(task);
      if (existing) return settleFromIntent(task, existing, recovery);
      if (recovery) {
        await repository.recoverWithoutExecution(task, { status: 'retry', retryAt: retryAt(task.attemptCount),
          reason: 'expired claim had no transaction intent; safe idempotent retry scheduled' });
        return 'retry';
      }
      const intent = await executeTask(task, {
        idempotencyKey: task.idempotencyKey,
        onIntentPersisted: persisted => repository.attachIntent(task, persisted.intentId),
      });
      return settleFromIntent(task, intent, false);
    } catch (error) {
      const transient = isTransientFailure(error);
      const outcome = await repository.fail(task, { reason: sanitizeError(error).slice(0, 500), transient,
        retryAt: transient ? retryAt(task.attemptCount) : null });
      await Promise.resolve(notify?.({ task, outcome, error })).catch(() => {});
      return outcome;
    }
  }

  async function recoverStaleClaims() {
    const tasks = await repository.listStaleClaims(now());
    for (const task of tasks) await processTask(task, true);
    return tasks.length;
  }

  async function tick() {
    if (inFlightCount >= maxConcurrentTasks) return false;
    inFlightCount += 1;
    lastTickAt=now();
    try {
      const task = await repository.claimDue({ workerId, now: now(), leaseMs });
      if (!task) {lastSuccessAt=now();lastError=null;return false;}
      await processTask(task, false);
      lastSuccessAt=now();lastError=null;
      return true;
    } catch(error){lastError=String(error?.message||'poll failed').slice(0,200);throw error;}
    finally { inFlightCount -= 1; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch(error => log(`Scheduler poll failed: ${sanitizeError(error)}`)), pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function health(){return {status:timer&&(!lastError||lastSuccessAt>=lastTickAt)?'up':'down',running:Boolean(timer),active:inFlightCount>0,inFlightCount,lastTickAt,lastSuccessAt,lastError};}
  return { health,processTask, recoverStaleClaims, start, stop, tick, workerId };
}

module.exports = { TRANSIENT_CODES, createSchedulerWorker, errorReason, isTransientFailure };
