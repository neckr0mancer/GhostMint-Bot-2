const { randomUUID } = require('node:crypto');
const { ValidationError } = require('../validation/domain');
const { TransactionSafetyError } = require('../transactions/transactionEngine');

// OpenSea reports a drop stage that has not opened yet with the same 409 it uses for one already
// over. Treated as transient because the common case by far is a stage flipping active a beat after
// its advertised second -- the identical request then succeeds. Bounded tightly below so the
// already-over case still fails fast instead of retrying into a window that will never reopen.
const STAGE_NOT_OPEN = 'STAGE_NOT_OPEN';
// A phase-aware task uses its stored time only as a durable wake-up. The execution layer throws
// this code when the intended phase is not live (or this wallet is not eligible for the current
// gated phase) and supplies a verified next phase/time. Unlike an RPC retry, this transition must
// not consume the task's bounded execution-attempt budget.
const SCHEDULE_PHASE_WAIT = 'SCHEDULE_PHASE_WAIT';
// Tight retry for stage-not-open: the contract may flip valid at the next block (400ms-2.5s).
// Backing off would only widen the miss, so we retry quickly and also on every new block via
// the chain watcher (see block-driven recheck below). Five retries plus one re-arm covers the
// T vs T+5s competitive case with margin.
const STAGE_NOT_OPEN_RETRY_MS = 250;
const STAGE_NOT_OPEN_MAX_ATTEMPTS = 8;
// Once that burst is spent, the schedule is consulted once more: a stage whose real opening moved
// (or was recorded wrongly when the task was created) is worth re-arming to rather than discarding,
// since the task exists precisely to be there at the open. Exactly ONE re-arm, and only to a time
// within a fixed window of what was originally scheduled -- a drop that keeps slipping must not
// leave tasks chasing it indefinitely. The re-arm grants a second burst at the new time.
const STAGE_REARM_MAX_ATTEMPTS = 12;
const STAGE_REARM_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TRANSIENT_CODES = new Set(['RPC_UNAVAILABLE', 'BROADCAST_UNKNOWN', 'NETWORK_ERROR', 'SERVER_ERROR',
  'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', STAGE_NOT_OPEN]);
const FINAL_TRANSACTION_STATES = new Set(['confirmed', 'reverted', 'replaced']);

function errorReason(error) {
  // A ValidationError's own `message` is always the constant 'Request validation failed' -- every
  // distinct permanent cause (the wallet was deleted, OpenSea returned calldata this app cannot
  // decode, OpenSea's quantity did not match what was requested, the chain is unsupported) reaches
  // both the user's notification and the stored last_error as that same opaque sentence. A live
  // "scheduled mints always fail" report was undiagnosable from either for exactly this reason --
  // all 17 such rows in the database read identically. The specifics are already carried in
  // `issues`; fold them in here, the single function both consumers read (server.js's failure
  // notification via event.error, and repository.fail's stored reason below).
  if (error instanceof ValidationError && Array.isArray(error.issues) && error.issues.length) {
    const detail = error.issues.map(item => `${item.field} ${item.message}`).join('; ');
    return `${error.message}: ${detail}`.slice(0, 500);
  }
  return String(error?.message || 'Unknown scheduler failure').slice(0, 500);
}

function isTransientFailure(error) {
  // A ValidationError is permanent by default -- a malformed request stays malformed. The one
  // exception carries its own code (STAGE_NOT_OPEN): the request is fine, it was simply early.
  if (error instanceof ValidationError) return TRANSIENT_CODES.has(error.code);
  if (error instanceof TransactionSafetyError) return TRANSIENT_CODES.has(error.code);
  return TRANSIENT_CODES.has(error?.code);
}

function executionAttemptCount(task) {
  // attemptCount is the immutable claim/audit sequence. Phase-only claims are tracked separately
  // so waiting for a delayed launch neither exhausts normal retries nor produces enormous
  // exponential backoff once the mint finally reaches RPC/simulation work.
  return Math.max(1, Number(task?.attemptCount || 0) - Number(task?.phaseWaitCount || 0));
}

function createSchedulerWorker({ repository, intentRepository, transactionEngine, executeTask,
  workerId = randomUUID(), now = () => Date.now(), leaseMs = 120_000,
  pollIntervalMs = 1_000, retryBaseMs = 5_000, notify, log = () => {}, sanitizeError = errorReason,
  // Called when a task enters STAGE_NOT_OPEN retry so the caller can ensure a block watcher
  // for that chain is running even if no sniper is active there.
  onStageNotOpen = null,
  // Optional: given a task whose stage would not open, returns the stage's real opening time in
  // epoch ms, or null when it cannot be resolved. Injected rather than imported so this worker
  // keeps knowing nothing about OpenSea; server.js supplies the lookup.
  resolveStageStart = null,
  // Optional durable preflight. It runs after idempotency/recovery checks but before the user is
  // told execution is starting. Phase-aware schedules use it to defer without producing a false
  // "starting" notification; its returned snapshot is passed to executeTask for reuse.
  preflightTask = null,
  // A single in-flight task used to serialize every scheduled mint behind whichever one claimed
  // first, even though processTask() waits for full on-chain finality (up to policy's
  // transactionTimeoutMs, 10 minutes by default) before returning -- a second task whose own
  // mint_time had already arrived sat unclaimed the entire time. Raising this from the old
  // single-slot guard to a small pool lets independent due tasks run concurrently; each `tick()`
  // call still fully awaits its own claimed task (unchanged -- see dashboard.test.js's
  // `await worker.tick()` expectation), so this only changes how many overlapping `tick()` calls
  // the existing setInterval loop is allowed to have outstanding at once.
  maxConcurrentTasks = 5,
  // A process can restart while another worker's lease is still valid. The one startup sweep
  // cannot recover it yet, so keep checking at a bounded cadence until the lease expires.
  staleRecoveryIntervalMs = Math.min(30_000, leaseMs),
  // Round 16 (docs/WORKLIST.md Section AV, item 4): "replace coarse polling with precise timers
  // for near-launch tasks." A task due more than this far out is left to the ordinary poll loop --
  // only one about to become due gets an exact setTimeout instead of waiting for the next tick.
  // Defaults to twice the poll interval so nothing can slip through the gap between one lookahead
  // scan and the next, even if a scan itself runs a little late.
  preciseArmWindowMs = pollIntervalMs * 2,
  // Optional pre-fire preparation hook (Round 16 item A3 follow-through): when prearmLeadMs > 0 and
  // a prearm fn is injected, every imminent task also gets a second timer prearmLeadMs ahead of its
  // fire moment. The worker knows nothing about what preparation means -- it never claims, never
  // mutates task state, and its failures are logged and forgotten, because executeTask must remain
  // able to do the whole job itself when no preparation happened (worker restart, lead just
  // introduced, task created inside the lead window). Re-arms automatically if mintTime moves.
  prearmLeadMs = 0, prearm = null }) {
  let timer = null;
  let recoveryTimer = null;
  let recoveryInFlight = false;
  let inFlightCount = 0;
  let lastTickAt=null;let lastSuccessAt=null;let lastError=null;
  const armedTimers = new Map();
  const prearmTimers = new Map();

  // Resolves the stage's real opening time, once, when the first burst is spent. Any failure here
  // degrades to the ordinary outcome -- a lookup problem must never turn a handled failure into a
  // throw, nor re-arm to something unverified.
  async function stageReopenAt(task) {
    if (!resolveStageStart) return null;
    let startAt;
    try { startAt = await resolveStageStart(task); } catch { return null; }
    if (!Number.isFinite(startAt) || startAt <= now()) return null;
    const scheduled = Number.isFinite(task.mintTime) ? task.mintTime : now();
    if (startAt - scheduled > STAGE_REARM_WINDOW_MS) return null;
    return startAt;
  }

  // How a stage-not-open failure is retried. Returns null to mean "handle it like anything else",
  // which for an exhausted budget is a permanent failure.
  async function stageWaitPlan(task) {
    const attempts = executionAttemptCount(task);
    const rearmed = attempts > STAGE_NOT_OPEN_MAX_ATTEMPTS;
    if (rearmed || attempts < STAGE_NOT_OPEN_MAX_ATTEMPTS) {
      return { retryAt: now() + STAGE_NOT_OPEN_RETRY_MS,
        maxAttempts: Math.max(task.maxAttempts, rearmed ? STAGE_REARM_MAX_ATTEMPTS : STAGE_NOT_OPEN_MAX_ATTEMPTS) };
    }
    const reopenAt = await stageReopenAt(task);
    if (reopenAt === null) return null;
    return { retryAt: reopenAt, maxAttempts: Math.max(task.maxAttempts, STAGE_REARM_MAX_ATTEMPTS) };
  }

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
      retryAt: retryAt(executionAttemptCount(task)), reason: `transaction remains ${current.state}; reconciliation will continue` });
    await Promise.resolve(notify?.({ task, outcome: 'retry', intent: current, recovery: true })).catch(() => {});
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
        await repository.recoverWithoutExecution(task, { status: 'retry', retryAt: retryAt(executionAttemptCount(task)),
          reason: 'expired claim had no transaction intent; safe idempotent retry scheduled' });
        await Promise.resolve(notify?.({ task, outcome: 'retry', recovery: true })).catch(() => {});
        return 'retry';
      }
      const preflight = preflightTask ? await preflightTask(task) : null;
      // This is informational only: the task is already due and will execute without waiting for
      // approval. Delivery is deliberately isolated from execution so a Telegram, Discord, or
      // dashboard outage cannot prevent the mint or change its eventual transaction state.
      try { Promise.resolve(notify?.({ task, outcome: 'starting' })).catch(() => {}); } catch { /* delivery is non-blocking */ }
      const intent = await executeTask(task, {
        idempotencyKey: task.idempotencyKey,
        onIntentPersisted: persisted => repository.attachIntent(task, persisted.intentId),
        preflight,
      });
      return settleFromIntent(task, intent, false);
    } catch (error) {
      if (error?.code === SCHEDULE_PHASE_WAIT && error.phaseDeferral && repository.deferForPhase) {
        const reason = sanitizeError(error).slice(0, 500);
        const deferred = await repository.deferForPhase(task, { ...error.phaseDeferral, reason });
        if (!deferred) {
          log(`Phase deferral lost its claim guard for scheduled task ${task.id}; no state was overwritten`);
          return 'retry';
        }
        Object.assign(task, deferred);
        await Promise.resolve(notify?.({ task, outcome: 'retry', error, phaseWait: true })).catch(() => {});
        return 'retry';
      }
      const transient = isTransientFailure(error);
      // A stage that has not opened is the one failure worth waiting on rather than abandoning:
      // a tight fixed burst first, then a single re-arm to the stage's real opening time. Both
      // budgeted apart from the task's own maxAttempts (default 3), which would otherwise be
      // spent in three seconds and leave nothing for a genuine RPC failure later in the same task.
      const stageWait = transient && error?.code === STAGE_NOT_OPEN;
      const plan = stageWait ? await stageWaitPlan(task) : null;
      if (stageWait && task.chain) {
        blockRetryChains.add(task.chain);
        try { await Promise.resolve(onStageNotOpen?.(task.chain)).catch(() => {}); } catch {}
      }
      const budgeted = plan ? { ...task, maxAttempts: plan.maxAttempts } : task;
      const outcome = await repository.fail(budgeted, { reason: sanitizeError(error).slice(0, 500), transient,
        retryAt: transient ? (plan ? plan.retryAt : retryAt(executionAttemptCount(task))) : null });
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
    if (inFlightCount >= maxConcurrentTasks) return 'throttled';
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

  // Round 16 (Section AV, item 4): read-only lookahead, no claiming -- arms one setTimeout per
  // imminent task not already armed, so it fires the instant it's due instead of waiting for the
  // next poll tick. A task whose own state changes before its timer fires (claimed by a regular
  // tick, cancelled, rescheduled) is harmless: the timer just calls tick(), and claimDue()'s own
  // WHERE clause simply won't match it anymore -- no cancellation bookkeeping needed for that.
  // When pre-arming is configured, the scan widens to cover the lead window too, and each scanned
  // task additionally gets a preparation timer at fire-moment-minus-lead (replacing an earlier one
  // if the task's mintTime moved). Fire timers stay gated to their own window so a far-out task
  // doesn't burn a pointless early tick().
  async function armPreciseTimers() {
    const prearmActive = Boolean(prearm) && prearmLeadMs > 0;
    // Without pre-arming this is byte-for-byte the original scan: everything listImminent returns
    // (already filtered to preciseArmWindowMs by the repository) gets a fire timer. Only an active
    // lead widens the scan -- and then fire timers stay gated to their own window, so a task seen
    // early purely for preparation doesn't burn a pointless premature tick().
    const withinMs = prearmActive ? Math.max(preciseArmWindowMs, prearmLeadMs) : preciseArmWindowMs;
    const tasks = await repository.listImminent({ now: now(), withinMs });
    for (const task of tasks) {
      if (!prearmActive || task.nextAttemptAt - now() <= preciseArmWindowMs) {
        const existing = armedTimers.get(task.id);
        if (existing) {
          if (existing.nextAttemptAt === task.nextAttemptAt) continue;
          clearTimeout(existing.handle);
        }
        const delay = Math.max(0, task.nextAttemptAt - now());
        const handle = setTimeout(() => {
          armedTimers.delete(task.id);
          const attempt = () => tick().then(result => {
            if (result === 'throttled') setTimeout(attempt, 50);
          }).catch(error => log(`Scheduler precise-fire failed: ${sanitizeError(error)}`));
          attempt();
        }, delay);
        handle.unref?.();
        armedTimers.set(task.id, { handle, nextAttemptAt: task.nextAttemptAt });
      }
      if (prearmActive) {
        const key = `${task.userId}:${task.id}`;
        const existing = prearmTimers.get(key);
        if (existing && existing.mintTime === task.mintTime) continue;
        if (existing) clearTimeout(existing.handle);
        const handle = setTimeout(() => {
          prearmTimers.delete(key);
          Promise.resolve(prearm(task))
            .catch(error => log(`Scheduler pre-arm failed for "${task.name}": ${sanitizeError(error)}`));
        }, Math.max(0, task.nextAttemptAt - prearmLeadMs - now()));
        handle.unref?.();
        prearmTimers.set(key, { handle, mintTime: task.mintTime });
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(error => log(`Scheduler poll failed: ${sanitizeError(error)}`));
      armPreciseTimers().catch(error => log(`Scheduler precise-arm failed: ${sanitizeError(error)}`));
    }, pollIntervalMs);
    timer.unref?.();
    recoveryTimer = setInterval(() => {
      if (recoveryInFlight) return;
      recoveryInFlight = true;
      recoverStaleClaims()
        .catch(error => log(`Scheduler stale-claim recovery failed: ${sanitizeError(error)}`))
        .finally(() => { recoveryInFlight = false; });
    }, Math.max(1, staleRecoveryIntervalMs));
    recoveryTimer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
    for (const entry of armedTimers.values()) clearTimeout(entry.handle ?? entry);
    armedTimers.clear();
    for (const entry of prearmTimers.values()) clearTimeout(entry.handle);
    prearmTimers.clear();
  }

  // Block-driven retry for STAGE_NOT_OPEN: when a scheduled mint fails because the contract
  // is not yet open, also retry on the next block (via chainWatcher) instead of only on the
  // 250ms timer. This reuses the same sniper block push so scheduled mints get instant
  // notification without polling. The timer remains as fallback for chains without WS.
  const blockRetryChains = new Set();
  function handleBlock(chain) {
    if (!blockRetryChains.has(chain)) return;
    blockRetryChains.delete(chain);
    tick().catch(error => log(`Scheduler block retry failed: ${sanitizeError(error)}`));
  }

  function hasBlockWaiters(chain) { return blockRetryChains.has(chain); }
  function health(){return {status:timer&&(!lastError||lastSuccessAt>=lastTickAt)?'up':'down',running:Boolean(timer),active:inFlightCount>0,inFlightCount,armedCount:armedTimers.size,prearmedCount:prearmTimers.size,lastTickAt,lastSuccessAt,lastError};}
  return { armPreciseTimers, handleBlock, hasBlockWaiters, health,processTask, recoverStaleClaims, start, stop, tick, workerId };
}

module.exports = { SCHEDULE_PHASE_WAIT, STAGE_NOT_OPEN, STAGE_NOT_OPEN_MAX_ATTEMPTS, STAGE_NOT_OPEN_RETRY_MS,
  STAGE_REARM_MAX_ATTEMPTS, STAGE_REARM_WINDOW_MS, TRANSIENT_CODES,
  createSchedulerWorker, errorReason, executionAttemptCount, isTransientFailure };
