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
    async listPageForUser(userId,{limit,offset}) {
      const [rows,count]=await Promise.all([pool.query(`SELECT * FROM mint_tasks WHERE user_id=$1
        ORDER BY mint_time,id LIMIT $2 OFFSET $3`,[userId,limit,offset]),
      pool.query('SELECT COUNT(*)::INTEGER AS total FROM mint_tasks WHERE user_id=$1',[userId])]);
      return {items:rows.rows.map(mapTask),total:count.rows[0].total};
    },

    async countActive() {
      const result = await pool.query("SELECT COUNT(*)::INTEGER AS count FROM mint_tasks WHERE status IN ('scheduled','retry','claimed','paused')");
      return result.rows[0].count;
    },

    async listStaleClaims(now) {
      const result = await pool.query(`SELECT * FROM mint_tasks WHERE status='claimed'
        AND lease_expires_at <= TO_TIMESTAMP($1 / 1000.0) ORDER BY lease_expires_at`, [now]);
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
  };
}

module.exports = { createSchedulerRepository, mapTask };
