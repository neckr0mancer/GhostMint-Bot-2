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
  pollIntervalMs = 1_000, retryBaseMs = 5_000, notify, log = () => {}, sanitizeError = errorReason }) {
  let timer = null;
  let active = false;

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
    if (active) return false;
    active = true;
    try {
      const task = await repository.claimDue({ workerId, now: now(), leaseMs });
      if (!task) return false;
      await processTask(task, false);
      return true;
    } finally { active = false; }
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

  return { processTask, recoverStaleClaims, start, stop, tick, workerId };
}

module.exports = { TRANSIENT_CODES, createSchedulerWorker, errorReason, isTransientFailure };
