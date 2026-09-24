const { scheduleReservationStageKey } = require('../mint/scheduleStagePlanning');
const { enforceScheduleAllowanceEnvelope, UNKNOWN } = require('../mint/scheduleAllowance');
const { armTaskPreflightRows, REVIEW_EXPIRED_REASON } = require('./scheduledPreflightRepository');

// The seven statuses the schema allows (migrations/011_durable_scheduler.sql:30), grouped into the
// buckets the dashboard filters by. Every status belongs to EXACTLY ONE bucket, which is the point:
// the counts sum to the total, no row is counted twice, and no row can become unreachable because
// no filter claims it. 'succeeded' has its own bucket for that last reason -- a mint that fired is
// still a row the user may want to look at.
const TASK_BUCKETS = Object.freeze({
  pending: ['scheduled', 'claimed', 'retry'],
  paused: ['paused'],
  failed: ['failed'],
  cancelled: ['cancelled'],
  succeeded: ['succeeded'],
});
const TASK_BUCKET_NAMES = Object.freeze(['pending', 'paused', 'failed', 'expired', 'cancelled', 'succeeded']);
// `expired` is the one bucket that is not a status. It is a paused or failed mint whose mint time
// has already gone: the drop is over, so Resume and Retry would only re-run something that cannot
// succeed. It TAKES PRECEDENCE over paused and failed, which keeps the buckets a partition -- a
// row is in exactly one, and the counts still sum to the total.
//
// Deliberately not applied to 'scheduled': an overdue scheduled mint is merely late, and the
// worker claims it within seconds. Nor to 'cancelled', which is a decision the user made rather
// than a window they missed, and saying "expired" would lose that.
const EXPIRABLE_STATUSES = Object.freeze(['paused', 'failed']);
// Expiry is not "the mint time has passed" -- a mint FAILS because its time arrived, so that test
// is true for essentially every failure and would leave the failed bucket permanently empty with
// everything piled into expired. It is "the time passed long enough ago that acting is pointless".
// Inside the grace a failure is worth retrying (a flaky RPC, a wallet you can top up); past it the
// drop is over and Retry would only re-run something that cannot succeed.
const EXPIRY_GRACE_MS = 60 * 60 * 1000;
const EXPIRY_GRACE_SQL = "NOW() - INTERVAL '1 hour'";
function bucketFor(status, isExpired) {
  const value = String(status || '').toLowerCase();
  if (isExpired && EXPIRABLE_STATUSES.includes(value)) return 'expired';
  return TASK_BUCKET_NAMES.find(name => TASK_BUCKETS[name]?.includes(value)) || null;
}
const BUCKET_OF_STATUS = Object.freeze(Object.fromEntries(
  Object.keys(TASK_BUCKETS).flatMap(name => TASK_BUCKETS[name].map(status => [status, name]))));
// Work this deployment still owns. Deliberately NOT the same as the `pending` bucket: paused is
// active (the row survives, the worker just will not fire it) but is not pending (it is suspended,
// not queued). Backlog §11.1, re-ruled 2026-08-19 -- the owner wants the two separable in the UI,
// so they cannot share one list here either.
const ACTIVE_STATUSES = Object.freeze([...TASK_BUCKETS.pending, ...TASK_BUCKETS.paused]);
const sqlStatusList = statuses => statuses.map(status => `'${status}'`).join(',');
// One WHERE fragment per bucket. Everything here is built from the frozen constants above --
// no caller input reaches these strings, so they stay literals rather than parameters.
const BUCKET_PREDICATES = Object.freeze({
  pending: `status IN (${sqlStatusList(TASK_BUCKETS.pending)})`,
  paused: `status='paused' AND mint_time >= ${EXPIRY_GRACE_SQL}`,
  failed: `status='failed' AND mint_time >= ${EXPIRY_GRACE_SQL}`,
  expired: `status IN (${sqlStatusList(EXPIRABLE_STATUSES)}) AND mint_time < ${EXPIRY_GRACE_SQL}`,
  cancelled: `status='cancelled'`,
  succeeded: `status='succeeded'`,
});

function time(value) { return value === null || value === undefined ? null : new Date(value).getTime(); }

function scheduleReservationConflict(message) {
  const error = new Error(message);
  error.code = 'SCHEDULE_STAGE_DUPLICATE';
  return error;
}

function scheduleAllowanceUnavailable(message) {
  const error = new Error(message);
  error.code = 'SCHEDULE_ALLOWANCE_UNAVAILABLE';
  return error;
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, name: row.name, walletLabel: row.wallet_label,
    contract: row.contract_address, fn: row.function_name, qty: row.quantity,
    price: Number(row.price_eth), gas: row.gas_gwei === null ? null : Number(row.gas_gwei),
    mintTime: time(row.mint_time), status: row.status, createdAt: time(row.created_at),
    nextAttemptAt: time(row.next_attempt_at), attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts, claimedBy: row.claimed_by, claimedAt: time(row.claimed_at),
    leaseExpiresAt: time(row.lease_expires_at), transactionIntentId: row.transaction_intent_id,
    idempotencyKey: row.idempotency_key, lastError: row.last_error, completedAt: time(row.completed_at),
    viaOpenSea: row.via_opensea, stageType: row.stage_type ?? null, chain: row.chain ?? null,
    stageUuid: row.stage_uuid ?? null, stageLabel: row.stage_label ?? null,
    walletAddress:row.wallet_address ?? null,reservationStageKey:row.reservation_stage_key ?? null,
    allowanceScope:row.allowance_scope ?? 'unknown',
    allowanceMaxPerWallet:row.allowance_max_per_wallet === null || row.allowance_max_per_wallet === undefined
      ? null:String(row.allowance_max_per_wallet),
    allowanceMintedSnapshot:row.allowance_minted_snapshot === null || row.allowance_minted_snapshot === undefined
      ? null:String(row.allowance_minted_snapshot),
    allowanceSource:row.allowance_source ?? null,
    allowanceVerifiedAt:time(row.allowance_verified_at),
    allowanceStageStartAt:time(row.allowance_stage_start_at),
    eligibilityMode: row.eligibility_mode ?? 'specific_stage',
    eligibilityDeadline: time(row.eligibility_deadline),
    phaseWaitCount: Number(row.phase_wait_count || 0),
    preflightTargetAt:time(row.preflight_target_at),
    preflightGeneration:Number(row.preflight_generation||1),
    originalOpeningAt:time(row.original_opening_at),acceptedOpeningAt:time(row.accepted_opening_at),
    lastObservedOpeningAt:time(row.last_observed_opening_at),
    timeChangePolicy:row.time_change_policy ?? 'approval',
    maxOpeningDelayMs:row.max_opening_delay_ms === null || row.max_opening_delay_ms === undefined
      ? null:Number(row.max_opening_delay_ms),
    acceptedPriceWeiPerItem:row.accepted_price_wei_per_item === null
      || row.accepted_price_wei_per_item === undefined ? null:String(row.accepted_price_wei_per_item),
    lastObservedPriceWeiPerItem:row.last_observed_price_wei_per_item === null
      || row.last_observed_price_wei_per_item === undefined ? null:String(row.last_observed_price_wei_per_item),
    priceChangePolicy:row.price_change_policy ?? 'approval',
    maxPriceWeiPerItem:row.max_price_wei_per_item === null || row.max_price_wei_per_item === undefined
      ? null:String(row.max_price_wei_per_item),
    acceptedConfigFingerprint:row.accepted_config_fingerprint ?? null,
    lastObservedConfigFingerprint:row.last_observed_config_fingerprint ?? null,
    acceptedConfigSummary:row.accepted_config_summary ?? null,
    lastObservedConfigSummary:row.last_observed_config_summary ?? null,
    changeState:row.change_state ?? 'clear',changeVersion:Number(row.change_version||0),
    pendingChange:row.pending_change ?? null,changeDetectedAt:time(row.change_detected_at),
    changeReviewExpiresAt:time(row.change_review_expires_at),
  };
}

function mapAttempt(row) {
  const transaction = row.transaction_intent_id ? {
    intentId:row.transaction_intent_id,
    state:row.intent_state ?? null,
    txHash:row.intent_tx_hash ?? null,
    failureReason:row.intent_failure_reason ?? null,
    chain:row.intent_chain ?? null,
    submittedAt:time(row.intent_submitted_at),
    finalizedAt:time(row.intent_finalized_at),
  } : null;
  return {
    attemptId:String(row.attempt_id),
    attemptNumber:Number(row.attempt_number),
    outcome:row.outcome,
    reason:row.reason ?? null,
    startedAt:time(row.started_at),
    finishedAt:time(row.finished_at),
    transaction,
  };
}

function createSchedulerRepository(pool) {
  async function claimDue({ workerId, now, leaseMs, userId = null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`WITH candidate AS (
        SELECT user_id,id FROM mint_tasks
        WHERE status IN ('scheduled','retry') AND next_attempt_at <= TO_TIMESTAMP($2 / 1000.0)
          AND ($4::UUID IS NULL OR user_id=$4)
        ORDER BY next_attempt_at,mint_time FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE mint_tasks task SET status='claimed',claimed_by=$1,claimed_at=TO_TIMESTAMP($2 / 1000.0),
        lease_expires_at=TO_TIMESTAMP(($2+$3) / 1000.0),attempt_count=attempt_count+1,last_error=NULL
        FROM candidate WHERE task.user_id=candidate.user_id AND task.id=candidate.id RETURNING task.*`,
      [workerId, now, leaseMs, userId]);
      if (!result.rowCount) { await client.query('COMMIT'); return null; }
      const task = mapTask(result.rows[0]);
      await client.query(`INSERT INTO mint_task_attempts
        (user_id,task_id,attempt_number,worker_id,outcome) VALUES ($1,$2,$3,$4,'running')`,
      [task.userId, task.id, task.attemptCount, workerId]);
      await client.query('COMMIT');
      return task;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function finishAttempt(client, task, outcome, reason, intentId) {
    await client.query(`UPDATE mint_task_attempts SET outcome=$4,reason=$5,
      transaction_intent_id=COALESCE($6,transaction_intent_id),finished_at=NOW()
      WHERE user_id=$1 AND task_id=$2 AND attempt_number=$3`,
    [task.userId, task.id, task.attemptCount, outcome, reason, intentId]);
  }

  return {
    claimDue,

    async listForUser(userId) {
      const result = await pool.query('SELECT * FROM mint_tasks WHERE user_id=$1 ORDER BY mint_time', [userId]);
      return result.rows.map(mapTask);
    },
    async detailsForUser(userId, id) {
      const taskResult = await pool.query(
        'SELECT * FROM mint_tasks WHERE user_id=$1 AND id=$2', [userId, id]);
      if (!taskResult.rowCount) return null;
      const [attempts,changes] = await Promise.all([pool.query(`SELECT attempt.*,
          intent.state AS intent_state,intent.tx_hash AS intent_tx_hash,
          intent.failure_reason AS intent_failure_reason,intent.chain AS intent_chain,
          intent.submitted_at AS intent_submitted_at,intent.finalized_at AS intent_finalized_at
        FROM mint_task_attempts attempt
        LEFT JOIN transaction_intents intent
          ON intent.intent_id=attempt.transaction_intent_id AND intent.user_id=attempt.user_id
        WHERE attempt.user_id=$1 AND attempt.task_id=$2
        ORDER BY attempt.attempt_number DESC`, [userId, id]),pool.query(`SELECT event_id,change_version,
          kinds,action,previous_snapshot,observed_snapshot,reason,created_at,resolved_at
        FROM mint_task_change_events WHERE user_id=$1 AND task_id=$2
        ORDER BY event_id DESC`,[userId,id])]);
      return { ...mapTask(taskResult.rows[0]), attempts:attempts.rows.map(mapAttempt),
        changeEvents:changes.rows.map(row=>({eventId:Number(row.event_id),version:Number(row.change_version),
          kinds:row.kinds||[],action:row.action,previous:row.previous_snapshot,
          observed:row.observed_snapshot,reason:row.reason,createdAt:time(row.created_at),
          resolvedAt:time(row.resolved_at)})) };
    },
    async listPageForUser(userId,{limit,offset,search,status}={}) {
      // Two scopes, and the difference matters. `counts` is scoped to the SEARCH only, so every
      // filter chip keeps showing its real number while one of them is applied -- a chip that read
      // 0 because its own filter is not the active one would be useless. `total` is scoped to the
      // search AND the status filter, because that is what the pager is paging through.
      const predicate=BUCKET_PREDICATES[status]||null;
      const filters=['user_id=$1'];const params=[userId];
      if(search){params.push(`%${search}%`);
        filters.push(`(name ILIKE $${params.length} OR wallet_label ILIKE $${params.length})`);}
      const countWhere=`WHERE ${filters.join(' AND ')}`;
      const countParams=[...params];
      if(predicate)filters.push(predicate);
      const listWhere=`WHERE ${filters.join(' AND ')}`;
      const listParams=[...params,limit,offset];
      const [rows,total,grouped]=await Promise.all([
        pool.query(`SELECT * FROM mint_tasks ${listWhere}
          ORDER BY mint_time,id LIMIT $${params.length+1} OFFSET $${params.length+2}`,listParams),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM mint_tasks ${listWhere}`,params),
        // One grouped count rather than one query per bucket. Grouped by status AND by whether the
        // mint time has gone, because 'expired' needs both to be decided.
        pool.query(`SELECT status, (mint_time < ${EXPIRY_GRACE_SQL}) AS expired, COUNT(*)::INTEGER AS total
          FROM mint_tasks ${countWhere} GROUP BY status, expired`,countParams)]);
      const counts=Object.fromEntries(TASK_BUCKET_NAMES.map(name=>[name,0]));
      for(const row of grouped.rows){const name=bucketFor(row.status,row.expired);if(name)counts[name]+=row.total;}
      return {items:rows.rows.map(mapTask),total:total.rows[0].total,counts};
    },

    // Claims newly-expired tasks and marks them in the SAME statement, so the row can only be
    // returned once even if two workers sweep at the same moment. The caller writes history for
    // whatever it gets back.
    async claimNewlyExpired(limit = 50) {
      const result = await pool.query(`WITH candidate AS (
          SELECT id FROM mint_tasks
          WHERE expired_logged_at IS NULL
            AND status IN (${sqlStatusList(EXPIRABLE_STATUSES)})
            AND mint_time < ${EXPIRY_GRACE_SQL}
          ORDER BY mint_time LIMIT $1
          FOR UPDATE SKIP LOCKED
        ) UPDATE mint_tasks SET expired_logged_at=NOW()
        FROM candidate WHERE mint_tasks.id=candidate.id RETURNING mint_tasks.*`, [limit]);
      return result.rows.map(mapTask);
    },

    // SEC-011: claimNewlyExpired marks rows logged in the same statement it returns them, so a
    // crashed history writer would otherwise lose the row forever. The sweep calls this per
    // failed task to hand the row back for the next pass.
    async clearExpiredLogged(ids) {
      if (!ids.length) return;
      await pool.query(`UPDATE mint_tasks SET expired_logged_at=NULL
        WHERE id = ANY($1::uuid[])`, [ids]);
    },

    // TX-020 (Model 2 phase-1): block-driven retry needs to wake ONE specific waiting task, not
    // whatever generic tick happens to claim -- a chain-level signal collapsed waiters and could
    // be consumed by an unrelated due task or before the waiter was even eligible. Mirrors
    // claimDue's locking for a single (user, task) pair; returns null when the row is no longer
    // scheduled/retry (claimed, cancelled, moved) -- the ordinary poll then owns it.
    async claimSpecific({ workerId, userId, taskId, now, leaseMs }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE mint_tasks task
          SET status='claimed',claimed_by=$1,claimed_at=TO_TIMESTAMP($2 / 1000.0),
            lease_expires_at=TO_TIMESTAMP(($2+$3) / 1000.0),attempt_count=attempt_count+1,last_error=NULL
          WHERE user_id=$4 AND id=$5 AND status IN ('scheduled','retry')
            AND next_attempt_at <= TO_TIMESTAMP($2 / 1000.0)
          RETURNING task.*`,
        [workerId, now, leaseMs, userId, taskId]);
        if (!result.rowCount) { await client.query('COMMIT'); return null; }
        const claimed = mapTask(result.rows[0]);
        await client.query(`INSERT INTO mint_task_attempts
          (user_id,task_id,attempt_number,worker_id,outcome) VALUES ($1,$2,$3,$4,'running')`,
        [claimed.userId, claimed.id, claimed.attemptCount, workerId]);
        await client.query('COMMIT');
        return claimed;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },

    async countActive() {
      const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM mint_tasks WHERE status IN (${sqlStatusList(ACTIVE_STATUSES)})`);
      return result.rows[0].count;
    },

    async listStaleClaims(now) {
      const result = await pool.query(`SELECT * FROM mint_tasks WHERE status='claimed'
        AND lease_expires_at <= TO_TIMESTAMP($1 / 1000.0) ORDER BY lease_expires_at`, [now]);
      return result.rows.map(mapTask);
    },

    // Round 16 (docs/WORKLIST.md Section AV, item 4): read-only lookahead, deliberately not a
    // claim -- no locking, no row mutation, safe to call as often as the caller likes. Lets
    // schedulerWorker.js arm a precise setTimeout for a task that's about to become due, instead of
    // waiting for the next poll tick to notice it. A task returned here that's already been
    // claimed, cancelled, or rescheduled by the time its timer fires is harmless: the timer just
    // calls tick(), and claimDue()'s own WHERE clause simply won't match it anymore.
    async listImminent({ now, withinMs }) {
      const result = await pool.query(`SELECT * FROM mint_tasks
        WHERE status IN ('scheduled','retry')
          AND next_attempt_at > TO_TIMESTAMP($1 / 1000.0)
          AND next_attempt_at <= TO_TIMESTAMP(($1 + $2) / 1000.0)
        ORDER BY next_attempt_at`, [now, withinMs]);
      return result.rows.map(mapTask);
    },

    async attachIntent(task, intentId) {
      await pool.query(`UPDATE mint_tasks SET transaction_intent_id=$4 WHERE user_id=$1 AND id=$2
        AND attempt_count=$3 AND status='claimed'`, [task.userId, task.id, task.attemptCount, intentId]);
      await pool.query(`UPDATE mint_task_attempts SET transaction_intent_id=$4 WHERE user_id=$1
        AND task_id=$2 AND attempt_number=$3`, [task.userId, task.id, task.attemptCount, intentId]);
    },

    async complete(task, intentId, reason = 'transaction confirmed') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE mint_tasks SET status='succeeded',transaction_intent_id=COALESCE($3,transaction_intent_id),
          completed_at=NOW(),claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,last_error=NULL
          WHERE user_id=$1 AND id=$2 AND status='claimed' AND attempt_count=$4`,
        [task.userId, task.id, intentId, task.attemptCount]);
        if (updated.rowCount) await finishAttempt(client, task, 'success', reason, intentId);
        await client.query('COMMIT');
        return updated.rowCount > 0;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async fail(task, { reason, transient, retryAt = null, intentId = null }) {
      const executionAttempts = Math.max(1, task.attemptCount - (task.phaseWaitCount || 0));
      const retry = transient && executionAttempts < task.maxAttempts;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE mint_tasks SET status=$3,next_attempt_at=COALESCE(TO_TIMESTAMP($4 / 1000.0),next_attempt_at),
          transaction_intent_id=COALESCE($5,transaction_intent_id),last_error=$6,
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,completed_at=CASE WHEN $3='failed' THEN NOW() ELSE NULL END
          WHERE user_id=$1 AND id=$2 AND status='claimed' AND attempt_count=$7`,
        [task.userId, task.id, retry ? 'retry' : 'failed', retryAt, intentId, reason, task.attemptCount]);
        if (updated.rowCount) await finishAttempt(client, task, retry ? 'retry' : 'failure', reason, intentId);
        await client.query('COMMIT');
        return updated.rowCount ? (retry ? 'retry' : 'failed') : 'superseded';
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async applyScheduleChange(task, evaluation) {
      const action=evaluation.action;
      if (!['accepted','auto_rescheduled','awaiting_approval','expired'].includes(action)) {
        return { outcome:'continue',task };
      }
      const observed=evaluation.observed||{};
      const continueClaim=action==='accepted';
      const nextStatus=continueClaim?'claimed':action==='auto_rescheduled'?'retry'
        :action==='awaiting_approval'?'paused':'failed';
      const version=Number(task.changeVersion||0)+1;
      const pending=action==='awaiting_approval'?{...evaluation,version}:null;
      const movedOpening=Number.isFinite(Number(observed.openingAt))?Number(observed.openingAt):null;
      const currentAttempt=task.nextAttemptAt??task.mintTime??null;
      const rescheduledTarget=action==='auto_rescheduled'&&movedOpening!==null
        ?Math.max(movedOpening,Number(currentAttempt)||movedOpening):movedOpening;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const updated=await client.query(`UPDATE mint_tasks SET
          status=$4,
          mint_time=CASE WHEN $5 AND $6::BIGINT IS NOT NULL THEN TO_TIMESTAMP($6 / 1000.0) ELSE mint_time END,
          next_attempt_at=CASE WHEN $5 AND $6::BIGINT IS NOT NULL THEN TO_TIMESTAMP($6 / 1000.0) ELSE next_attempt_at END,
          accepted_opening_at=CASE WHEN $8 AND $7::BIGINT IS NOT NULL THEN TO_TIMESTAMP($7 / 1000.0) ELSE accepted_opening_at END,
          last_observed_opening_at=CASE WHEN $7::BIGINT IS NULL THEN last_observed_opening_at ELSE TO_TIMESTAMP($7 / 1000.0) END,
          accepted_price_wei_per_item=CASE WHEN $8 AND $9::NUMERIC IS NOT NULL THEN $9::NUMERIC ELSE accepted_price_wei_per_item END,
          last_observed_price_wei_per_item=COALESCE($9::NUMERIC,last_observed_price_wei_per_item),
          accepted_config_fingerprint=CASE WHEN $8 AND $10::TEXT IS NOT NULL AND $11::JSONB IS NOT NULL THEN $10 ELSE accepted_config_fingerprint END,
          last_observed_config_fingerprint=CASE WHEN $10::TEXT IS NOT NULL AND $11::JSONB IS NOT NULL THEN $10 ELSE last_observed_config_fingerprint END,
          accepted_config_summary=CASE WHEN $8 AND $10::TEXT IS NOT NULL AND $11::JSONB IS NOT NULL THEN $11::JSONB ELSE accepted_config_summary END,
          last_observed_config_summary=CASE WHEN $10::TEXT IS NOT NULL AND $11::JSONB IS NOT NULL THEN $11::JSONB ELSE last_observed_config_summary END,
          change_state=CASE WHEN $12 THEN 'awaiting_approval' ELSE 'clear' END,
          change_version=$13,pending_change=$14::JSONB,change_detected_at=NOW(),last_error=$15,
          change_review_expires_at=CASE WHEN $12 THEN
            LEAST(COALESCE(eligibility_deadline,'infinity'::TIMESTAMPTZ),NOW()+INTERVAL '24 hours')
            ELSE NULL END,
          preflight_target_at=CASE WHEN $5 AND $6::BIGINT IS NOT NULL THEN TO_TIMESTAMP($6 / 1000.0) ELSE preflight_target_at END,
          preflight_generation=preflight_generation+CASE WHEN $5 THEN 1 ELSE 0 END,
          claimed_by=CASE WHEN $16 THEN claimed_by ELSE NULL END,
          claimed_at=CASE WHEN $16 THEN claimed_at ELSE NULL END,
          lease_expires_at=CASE WHEN $16 THEN lease_expires_at ELSE NULL END,
          completed_at=CASE WHEN $4='failed' THEN NOW() ELSE NULL END
          WHERE user_id=$1 AND id=$2 AND status='claimed' AND attempt_count=$3
            AND change_version=$17 RETURNING *`,
        [task.userId,task.id,task.attemptCount,nextStatus,action==='auto_rescheduled',rescheduledTarget,
          movedOpening,action==='accepted'||action==='auto_rescheduled',observed.priceWeiPerItem??null,
          observed.configFingerprint??null,observed.configSummary?JSON.stringify(observed.configSummary):null,
          action==='awaiting_approval',version,pending?JSON.stringify(pending):null,
          evaluation.reason||null,continueClaim,
          Number(task.changeVersion||0)]);
        if(!updated.rowCount){await client.query('COMMIT');return {outcome:'superseded',task};}
        const saved=mapTask(updated.rows[0]);
        await client.query(`INSERT INTO mint_task_change_events
          (user_id,task_id,change_version,event_fingerprint,kinds,action,previous_snapshot,observed_snapshot,reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9)
          ON CONFLICT (user_id,task_id,change_version) DO NOTHING`,
        [task.userId,task.id,version,evaluation.eventFingerprint,evaluation.kinds,action,
          JSON.stringify(evaluation.previous),JSON.stringify(observed),evaluation.reason]);
        if(action==='auto_rescheduled')await armTaskPreflightRows(client,updated.rows[0]);
        if(!continueClaim)await finishAttempt(client,task,action==='expired'?'failure':'retry',evaluation.reason,null);
        await client.query('COMMIT');
        return {outcome:continueClaim?'continue':action==='auto_rescheduled'?'retry':action==='awaiting_approval'?'paused':'failed',task:saved};
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    },

    async resolveScheduleChange(userId,id,{decision,version,now=Date.now()}) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const found=await client.query(`SELECT * FROM mint_tasks
          WHERE user_id=$1 AND id=$2 FOR UPDATE`,[userId,id]);
        if(!found.rowCount){await client.query('ROLLBACK');return null;}
        const row=found.rows[0];
        if(row.change_state==='awaiting_approval'&&row.status==='paused'
          &&time(row.change_review_expires_at)!==null&&time(row.change_review_expires_at)<=now){
          await client.query(`UPDATE mint_tasks SET status='failed',change_state='clear',
              pending_change=NULL,change_review_expires_at=NULL,last_error=$3,
              completed_at=TO_TIMESTAMP($4 / 1000.0),
              claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
            WHERE user_id=$1 AND id=$2 AND status='paused' AND change_state='awaiting_approval'`,
          [userId,id,REVIEW_EXPIRED_REASON,now]);
          await client.query(`UPDATE mint_task_change_events SET action='expired',
              resolved_at=TO_TIMESTAMP($4 / 1000.0)
            WHERE user_id=$1 AND task_id=$2 AND change_version=$3 AND action='awaiting_approval'`,
          [userId,id,row.change_version,now]);
          await client.query(`UPDATE mint_task_preflight_checks SET state='superseded',
              claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
            WHERE user_id=$1 AND task_id=$2 AND state IN ('pending','claimed')`,[userId,id]);
          await client.query(`INSERT INTO mint_task_preflight_checks
              (user_id,task_id,generation,target_at,checkpoint,due_at,state,result,reason,checked_at,
               schedule_change_action,schedule_change_version,schedule_change_reason)
            VALUES ($1,$2,$3,$4,'change_review_expiry',$5,'completed','review_expired',$6,$5,
              'expired',$7,$6)
            ON CONFLICT (user_id,task_id,generation,checkpoint) DO NOTHING`,
          [userId,id,row.preflight_generation,row.change_review_expires_at,new Date(now),
            REVIEW_EXPIRED_REASON,row.change_version]);
          await client.query('COMMIT');
          const error=new Error('This schedule review expired before a decision was received. Nothing was sent.');
          error.code='SCHEDULE_CHANGE_EXPIRED';error.committed=true;throw error;
        }
        if(row.change_state!=='awaiting_approval'||Number(row.change_version)!==Number(version)
          ||row.status!=='paused'){
          const error=new Error('This schedule change is no longer current. Refresh its details.');
          error.code='SCHEDULE_CHANGE_STALE';throw error;
        }
        const pending=row.pending_change||{};
        let updated;
        if(decision==='cancel'){
          updated=await client.query(`UPDATE mint_tasks SET status='cancelled',change_state='clear',
            pending_change=NULL,change_review_expires_at=NULL,
            last_error='Cancelled after a schedule change was reviewed',completed_at=NOW()
            WHERE user_id=$1 AND id=$2 RETURNING *`,[userId,id]);
        }else{
          const observed=pending.observed||{};
          const opening=Number.isFinite(Number(observed.openingAt))?Number(observed.openingAt):null;
          // Approval may accept a later opening, price, or call configuration, but it must never
          // move the user's earliest execution time backwards. A price-only review for a stage
          // that opened before the chosen mint time therefore remains pinned to that chosen time.
          const approvedExecutionAt=Math.max(now,time(row.mint_time)??now,opening??0);
          updated=await client.query(`UPDATE mint_tasks SET status='retry',
            mint_time=TO_TIMESTAMP($3 / 1000.0),
            next_attempt_at=TO_TIMESTAMP($4 / 1000.0),
            accepted_opening_at=CASE WHEN $5::BIGINT IS NULL THEN accepted_opening_at ELSE TO_TIMESTAMP($5 / 1000.0) END,
            accepted_price_wei_per_item=COALESCE($6::NUMERIC,accepted_price_wei_per_item),
            accepted_config_fingerprint=CASE WHEN $7::TEXT IS NOT NULL AND $8::JSONB IS NOT NULL THEN $7 ELSE accepted_config_fingerprint END,
            accepted_config_summary=CASE WHEN $7::TEXT IS NOT NULL AND $8::JSONB IS NOT NULL THEN $8::JSONB ELSE accepted_config_summary END,
            change_state='clear',pending_change=NULL,change_review_expires_at=NULL,
            last_error=NULL,completed_at=NULL,
            claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,
            preflight_target_at=TO_TIMESTAMP($4 / 1000.0),preflight_generation=preflight_generation+1
            WHERE user_id=$1 AND id=$2 RETURNING *`,[userId,id,approvedExecutionAt,
          approvedExecutionAt,opening,observed.priceWeiPerItem??null,
          observed.configFingerprint??null,
          observed.configSummary?JSON.stringify(observed.configSummary):null]);
          await armTaskPreflightRows(client,updated.rows[0]);
        }
        await client.query(`UPDATE mint_task_change_events SET action=$4,resolved_at=NOW()
          WHERE user_id=$1 AND task_id=$2 AND change_version=$3`,
        [userId,id,version,decision==='approve'?'approved':'cancelled']);
        await client.query('COMMIT');return mapTask(updated.rows[0]);
      }catch(error){if(!error?.committed)await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    },

    async deferForPhase(task, details) {
      const { retryAt, mintTime, stageUuid, stageLabel, stageType, reason } = details;
      const mintTimeSupplied = Object.prototype.hasOwnProperty.call(details, 'mintTime');
      const deadlineSupplied = Object.prototype.hasOwnProperty.call(details, 'deadline');
      const deadline = deadlineSupplied ? details.deadline : null;
      const stageUuidSupplied = Object.prototype.hasOwnProperty.call(details, 'stageUuid');
      const stageLabelSupplied = Object.prototype.hasOwnProperty.call(details, 'stageLabel');
      const stageTypeSupplied = Object.prototype.hasOwnProperty.call(details, 'stageType');
      const reservationChanged = mintTimeSupplied || stageUuidSupplied || stageLabelSupplied || stageTypeSupplied;
      const reservationStageKey = reservationChanged ? scheduleReservationStageKey({
        stageUuid:stageUuidSupplied ? stageUuid : task.stageUuid,
        stageLabel:stageLabelSupplied ? stageLabel : task.stageLabel,
        stageType:stageTypeSupplied ? stageType : task.stageType,
        mintTime:mintTimeSupplied ? mintTime : task.mintTime,
      }) : task.reservationStageKey;
      const suppliedEvidence = details.allowanceEvidence && typeof details.allowanceEvidence === 'object'
        ? details.allowanceEvidence : {};
      const allowanceStageStartAt = suppliedEvidence.allowanceStageStartAt
        ?? details.stageStartAt ?? (mintTimeSupplied ? mintTime : retryAt);
      // A stage move with no authoritative resolver result remains unknown. That is deliberately
      // different from zero: unknown evidence never creates a guessed hard cap, but the envelope
      // check below still refuses the move if an existing later cumulative boundary needs a fresh
      // contract-wide minted snapshot.
      const allowanceEvidence = reservationChanged ? {
        allowanceScope:suppliedEvidence.allowanceScope ?? UNKNOWN,
        allowanceMaxPerWallet:suppliedEvidence.allowanceMaxPerWallet ?? null,
        allowanceMintedSnapshot:suppliedEvidence.allowanceMintedSnapshot ?? null,
        allowanceContractMintedSnapshot:suppliedEvidence.allowanceContractMintedSnapshot ?? null,
        allowanceSource:suppliedEvidence.allowanceSource ?? null,
        allowanceVerifiedAt:suppliedEvidence.allowanceVerifiedAt ?? null,
        allowanceStageStartAt,
      } : null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (reservationChanged) {
          // The scheduler can encounter a legacy row whose wallet_address/chain columns predate
          // reservation persistence. Resolve that identity from the owned wallet rather than
          // moving it outside the same advisory-lock envelope used by new schedule creation.
          const identity = await client.query(`SELECT
              COALESCE(NULLIF(task.wallet_address,''),wallet.address) AS wallet_address,
              COALESCE(NULLIF(task.chain,''),wallet.chain) AS chain,
              task.contract_address
            FROM mint_tasks task
            LEFT JOIN wallets wallet ON wallet.user_id=task.user_id
              AND LOWER(wallet.label)=LOWER(task.wallet_label)
            WHERE task.user_id=$1 AND task.id=$2`,[task.userId,task.id]);
          const envelope = identity.rows[0] || {};
          if (!envelope.wallet_address || !envelope.chain || !envelope.contract_address
            || !reservationStageKey) {
            throw scheduleAllowanceUnavailable(
              'The wallet allowance could not be rechecked while moving this schedule. Try again shortly.');
          }
          const lockKey = [task.userId,String(envelope.wallet_address).toLowerCase(),
            String(envelope.chain).toLowerCase(),String(envelope.contract_address).toLowerCase()].join('|');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
          const active = await client.query(`SELECT active_task.* FROM mint_tasks active_task
            LEFT JOIN wallets wallet ON wallet.user_id=active_task.user_id
              AND LOWER(wallet.label)=LOWER(active_task.wallet_label)
            WHERE active_task.user_id=$1 AND active_task.id<>$5
              AND LOWER(COALESCE(NULLIF(active_task.wallet_address,''),wallet.address))=LOWER($2)
              AND LOWER(COALESCE(NULLIF(active_task.chain,''),wallet.chain))=LOWER($3)
              AND LOWER(active_task.contract_address)=LOWER($4)
              AND active_task.status IN ('scheduled','claimed','retry','paused')
            ORDER BY active_task.created_at,active_task.id FOR UPDATE OF active_task`,
          [task.userId,envelope.wallet_address,envelope.chain,envelope.contract_address,task.id]);
          const activeTasks = active.rows.map(mapTask);
          const conflict = activeTasks.find(existing => {
            const key = existing.reservationStageKey || scheduleReservationStageKey({
              stageUuid:existing.stageUuid,stageLabel:existing.stageLabel,
              stageType:existing.stageType,mintTime:existing.mintTime,
            });
            return key === reservationStageKey;
          });
          if (conflict) {
            throw scheduleReservationConflict(
              'This wallet already has an active mint scheduled for the next stage.');
          }
          enforceScheduleAllowanceEnvelope(activeTasks,{
            ...task,walletAddress:envelope.wallet_address,chain:envelope.chain,
            contract:envelope.contract_address,
            mintTime:mintTimeSupplied ? mintTime : task.mintTime,
            stageUuid:stageUuidSupplied ? stageUuid : task.stageUuid,
            stageLabel:stageLabelSupplied ? stageLabel : task.stageLabel,
            stageType:stageTypeSupplied ? stageType : task.stageType,
            reservationStageKey,...allowanceEvidence,
          });
        }
        const updated = await client.query(`UPDATE mint_tasks SET status='retry',
          mint_time=CASE WHEN $5 THEN TO_TIMESTAMP($6 / 1000.0) ELSE mint_time END,
          next_attempt_at=TO_TIMESTAMP($4 / 1000.0),phase_wait_count=phase_wait_count+1,
          eligibility_deadline=CASE WHEN $7 THEN
            CASE WHEN $8::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($8 / 1000.0) END
            ELSE eligibility_deadline END,
          stage_uuid=CASE WHEN $9 THEN $10 ELSE stage_uuid END,
          stage_label=CASE WHEN $11 THEN $12 ELSE stage_label END,
          stage_type=CASE WHEN $13 THEN $14 ELSE stage_type END,last_error=$15,
          reservation_stage_key=CASE WHEN $16 THEN $17 ELSE reservation_stage_key END,
          allowance_scope=CASE WHEN $16 THEN $18 ELSE allowance_scope END,
          allowance_max_per_wallet=CASE WHEN $16 THEN $19 ELSE allowance_max_per_wallet END,
          allowance_minted_snapshot=CASE WHEN $16 THEN $20 ELSE allowance_minted_snapshot END,
          allowance_source=CASE WHEN $16 THEN $21 ELSE allowance_source END,
          allowance_verified_at=CASE WHEN $16 THEN
            CASE WHEN $22::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($22 / 1000.0) END
            ELSE allowance_verified_at END,
          allowance_stage_start_at=CASE WHEN $16 THEN
            CASE WHEN $23::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($23 / 1000.0) END
            ELSE allowance_stage_start_at END,
          preflight_target_at=CASE WHEN $16 THEN
            CASE WHEN $5 THEN TO_TIMESTAMP($6 / 1000.0) ELSE TO_TIMESTAMP($4 / 1000.0) END
            ELSE preflight_target_at END,
          preflight_generation=preflight_generation+CASE WHEN $16 THEN 1 ELSE 0 END,
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,completed_at=NULL
          WHERE user_id=$1 AND id=$2 AND status='claimed' AND attempt_count=$3 RETURNING *`,
        [task.userId, task.id, task.attemptCount, retryAt, mintTimeSupplied, mintTime ?? null,
          deadlineSupplied, deadline, stageUuidSupplied, stageUuid ?? null,
          stageLabelSupplied, stageLabel ?? null, stageTypeSupplied, stageType ?? null, reason,
          reservationChanged,reservationStageKey,
          allowanceEvidence?.allowanceScope ?? null,allowanceEvidence?.allowanceMaxPerWallet ?? null,
          allowanceEvidence?.allowanceMintedSnapshot ?? null,allowanceEvidence?.allowanceSource ?? null,
          allowanceEvidence?.allowanceVerifiedAt ?? null,allowanceEvidence?.allowanceStageStartAt ?? null]);
        if (updated.rowCount) {
          await finishAttempt(client, task, 'retry', reason, null);
          await armTaskPreflightRows(client,updated.rows[0]);
        }
        await client.query('COMMIT');
        return mapTask(updated.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505' && error.constraint === 'mint_tasks_active_wallet_contract_stage_uniq') {
          throw scheduleReservationConflict('This wallet already has an active mint scheduled for the next stage.');
        }
        throw error;
      }
      finally { client.release(); }
    },

    async recoverWithoutExecution(task, { status, reason, intentId = null, retryAt = null }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE mint_tasks SET status=$3,next_attempt_at=COALESCE(TO_TIMESTAMP($4 / 1000.0),next_attempt_at),
          transaction_intent_id=COALESCE($5,transaction_intent_id),last_error=$6,
          completed_at=CASE WHEN $3 IN ('succeeded','failed') THEN NOW() ELSE completed_at END,
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE user_id=$1 AND id=$2
          AND status='claimed' AND attempt_count=$7`,
        [task.userId, task.id, status, retryAt, intentId, reason, task.attemptCount]);
        if (updated.rowCount) await finishAttempt(client, task, 'recovered', reason, intentId);
        await client.query('COMMIT');
        return updated.rowCount > 0;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async cancel(userId, id) {
      const result = await pool.query(`UPDATE mint_tasks SET status='cancelled',completed_at=NOW()
        WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry','paused') RETURNING *`, [userId, id]);
      return mapTask(result.rows[0]);
    },
    async pause(userId, id) {
      const result = await pool.query(`UPDATE mint_tasks SET status='paused',
          preflight_generation=preflight_generation+1
        WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry') RETURNING *`, [userId, id]);
      return mapTask(result.rows[0]);
    },
    async resume(userId, id, now) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const result=await client.query(`UPDATE mint_tasks SET status='scheduled',
            next_attempt_at=GREATEST(mint_time,TO_TIMESTAMP($3 / 1000.0)),
            preflight_target_at=GREATEST(mint_time,TO_TIMESTAMP($3 / 1000.0)),last_error=NULL
          WHERE user_id=$1 AND id=$2 AND status='paused' AND change_state='clear' RETURNING *`,[userId,id,now]);
        if(result.rowCount)await armTaskPreflightRows(client,result.rows[0]);
        await client.query('COMMIT');
        return mapTask(result.rows[0]);
      } catch(error) {
        await client.query('ROLLBACK').catch(()=>{});throw error;
      } finally { client.release(); }
    },
    async retry(userId, id, now) {
      try {
        const result = await pool.query(`UPDATE mint_tasks SET status='retry',next_attempt_at=TO_TIMESTAMP($3 / 1000.0),
          last_error=NULL,completed_at=NULL
          WHERE user_id=$1 AND id=$2 AND status='failed' AND change_state='clear'
            AND (attempt_count-phase_wait_count) < max_attempts RETURNING *`, [userId, id, now]);
        return mapTask(result.rows[0]);
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'mint_tasks_active_wallet_contract_stage_uniq') {
          throw scheduleReservationConflict('This wallet already has another active mint scheduled for this stage.');
        }
        throw error;
      }
    },

    // Pre-arm fire-time correction (scheduledValidity): the contract's own window differs from the
    // advertised time, so move next_attempt_at to the REAL opening before T arrives -- the precise
    // timers re-arm on the change (schedulerWorker compares nextAttemptAt) and the first attempt
    // lands valid with zero failed tries. Only a still-'scheduled' task moves: claimed/retried/
    // paused rows are owned by other paths. mint_time (what the user sees) is deliberately kept.
    async moveFireTime(userId, id, fireAtMs) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const result=await client.query(`UPDATE mint_tasks SET
            next_attempt_at=TO_TIMESTAMP($3 / 1000.0),
            preflight_target_at=TO_TIMESTAMP($3 / 1000.0),
            preflight_generation=preflight_generation+1
          WHERE user_id=$1 AND id=$2 AND status='scheduled' RETURNING *`,[userId,id,fireAtMs]);
        if(result.rowCount)await armTaskPreflightRows(client,result.rows[0]);
        await client.query('COMMIT');
        return mapTask(result.rows[0]);
      } catch(error) {
        await client.query('ROLLBACK').catch(()=>{});throw error;
      } finally { client.release(); }
    },
  };
}

module.exports = { ACTIVE_STATUSES, BUCKET_OF_STATUS, BUCKET_PREDICATES, EXPIRABLE_STATUSES, EXPIRY_GRACE_MS,
  TASK_BUCKETS, TASK_BUCKET_NAMES, bucketFor, createSchedulerRepository, mapTask };
