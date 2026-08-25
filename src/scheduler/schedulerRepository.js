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

function time(value) { return value === null ? null : new Date(value).getTime(); }

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
      const retry = transient && task.attemptCount < task.maxAttempts;
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
      const result = await pool.query(`UPDATE mint_tasks SET status='paused'
        WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry') RETURNING *`, [userId, id]);
      return mapTask(result.rows[0]);
    },
    async resume(userId, id, now) {
      const result = await pool.query(`UPDATE mint_tasks SET status='scheduled',next_attempt_at=GREATEST(mint_time,TO_TIMESTAMP($3 / 1000.0)),last_error=NULL
        WHERE user_id=$1 AND id=$2 AND status='paused' RETURNING *`, [userId, id, now]);
      return mapTask(result.rows[0]);
    },
    async retry(userId, id, now) {
      const result = await pool.query(`UPDATE mint_tasks SET status='retry',next_attempt_at=TO_TIMESTAMP($3 / 1000.0),
        max_attempts=GREATEST(max_attempts,attempt_count+1),last_error=NULL,completed_at=NULL
        WHERE user_id=$1 AND id=$2 AND status='failed' RETURNING *`, [userId, id, now]);
      return mapTask(result.rows[0]);
    },

    // Pre-arm fire-time correction (scheduledValidity): the contract's own window differs from the
    // advertised time, so move next_attempt_at to the REAL opening before T arrives -- the precise
    // timers re-arm on the change (schedulerWorker compares nextAttemptAt) and the first attempt
    // lands valid with zero failed tries. Only a still-'scheduled' task moves: claimed/retried/
    // paused rows are owned by other paths. mint_time (what the user sees) is deliberately kept.
    async moveFireTime(userId, id, fireAtMs) {
      const result = await pool.query(`UPDATE mint_tasks SET next_attempt_at=TO_TIMESTAMP($3 / 1000.0)
        WHERE user_id=$1 AND id=$2 AND status='scheduled' RETURNING *`, [userId, id, fireAtMs]);
      return mapTask(result.rows[0]);
    },
  };
}

module.exports = { ACTIVE_STATUSES, BUCKET_OF_STATUS, BUCKET_PREDICATES, EXPIRABLE_STATUSES, EXPIRY_GRACE_MS,
  TASK_BUCKETS, TASK_BUCKET_NAMES, bucketFor, createSchedulerRepository, mapTask };
