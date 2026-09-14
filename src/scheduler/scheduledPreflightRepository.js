const CHECKPOINTS = Object.freeze([
  Object.freeze({ name:'five_minute', leadMs:5 * 60 * 1000 }),
  Object.freeze({ name:'thirty_second', leadMs:30 * 1000 }),
]);
const ACTIVE_TASK_STATUSES = Object.freeze(['scheduled','retry']);

function time(value) { return value === null || value === undefined ? null : new Date(value).getTime(); }
function numeric(value) { return value === null || value === undefined ? null : String(value); }

function mapTask(row) {
  return {
    id:row.id,userId:row.user_id,name:row.name,walletLabel:row.wallet_label,
    walletAddress:row.wallet_address ?? null,contract:row.contract_address,
    fn:row.function_name,qty:row.quantity,price:Number(row.price_eth),
    gas:row.gas_gwei===null?null:Number(row.gas_gwei),chain:row.chain ?? null,
    mintTime:time(row.mint_time),status:row.status,createdAt:time(row.created_at),
    nextAttemptAt:time(row.next_attempt_at),attemptCount:row.attempt_count,
    maxAttempts:row.max_attempts,viaOpenSea:row.via_opensea,
    stageType:row.stage_type ?? null,stageUuid:row.stage_uuid ?? null,
    stageLabel:row.stage_label ?? null,eligibilityMode:row.eligibility_mode ?? 'specific_stage',
    eligibilityDeadline:time(row.eligibility_deadline),phaseWaitCount:Number(row.phase_wait_count||0),
    preflightTargetAt:time(row.preflight_target_at),
    preflightGeneration:Number(row.preflight_generation||1),
  };
}

function mapCheck(row) {
  return {
    checkId:String(row.check_id),userId:row.user_id,taskId:row.task_id,
    generation:Number(row.generation),checkpoint:row.checkpoint,targetAt:time(row.target_at),
    dueAt:time(row.due_at),state:row.state,result:row.result ?? null,reason:row.reason ?? null,
    mintValueWei:numeric(row.mint_value_wei),estimatedGasWei:numeric(row.estimated_gas_wei),
    totalDebitWei:numeric(row.total_debit_wei),balanceWei:numeric(row.balance_wei),
    shortfallWei:numeric(row.shortfall_wei),claimedBy:row.claimed_by ?? null,
    claimedAt:time(row.claimed_at),leaseExpiresAt:time(row.lease_expires_at),
    checkedAt:time(row.checked_at),notificationAttemptedAt:time(row.notification_attempted_at),
    notificationError:row.notification_error ?? null,
    notificationState:row.notification_state ?? 'pending',
    notificationAttempts:Number(row.notification_attempts||0),
    notificationNextAttemptAt:time(row.notification_next_attempt_at),
    notificationClaimedBy:row.notification_claimed_by ?? null,
    notificationClaimedAt:time(row.notification_claimed_at),
    notificationLeaseExpiresAt:time(row.notification_lease_expires_at),
    notificationDeliveredAt:time(row.notification_delivered_at),createdAt:time(row.created_at),
  };
}

// Called from the same transaction that creates or semantically re-arms a task. A five-minute
// checkpoint is not fabricated when only <=30 seconds remain; the final checkpoint still runs.
async function armTaskPreflightRows(queryable, row) {
  if (!row) return;
  const targetAt=time(row.preflight_target_at ?? row.next_attempt_at ?? row.mint_time);
  const generation=Number(row.preflight_generation||1);
  await queryable.query(`UPDATE mint_task_preflight_checks SET state='superseded',
      claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
    WHERE user_id=$1 AND task_id=$2 AND generation<>$3 AND state IN ('pending','claimed')`,
  [row.user_id,row.id,generation]);
  if (!ACTIVE_TASK_STATUSES.includes(String(row.status||'').toLowerCase()) || !Number.isFinite(targetAt)) return;
  await queryable.query(`INSERT INTO mint_task_preflight_checks
      (user_id,task_id,generation,target_at,checkpoint,due_at)
    SELECT $1,$2,$3,TO_TIMESTAMP($4 / 1000.0),schedule.checkpoint,
      TO_TIMESTAMP(($4-schedule.lead_ms) / 1000.0)
    FROM (VALUES ('five_minute'::TEXT,300000::BIGINT),
      ('thirty_second'::TEXT,30000::BIGINT)) AS schedule(checkpoint,lead_ms)
    WHERE TO_TIMESTAMP($4 / 1000.0)>NOW()
      AND (schedule.checkpoint<>'five_minute'
        OR TO_TIMESTAMP($4 / 1000.0)>NOW()+INTERVAL '30 seconds')
    ON CONFLICT (user_id,task_id,generation,checkpoint) DO UPDATE SET
      target_at=EXCLUDED.target_at,due_at=EXCLUDED.due_at,state='pending',result=NULL,reason=NULL,
      mint_value_wei=NULL,estimated_gas_wei=NULL,total_debit_wei=NULL,balance_wei=NULL,
      shortfall_wei=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,checked_at=NULL,
      notification_attempted_at=NULL,notification_error=NULL
    WHERE mint_task_preflight_checks.state='superseded'`,
  [row.user_id,row.id,generation,targetAt]);
}

function createScheduledPreflightRepository(pool) {
  async function sync(now=Date.now()) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE mint_task_preflight_checks checkpoint SET state='superseded',
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
        WHERE checkpoint.state IN ('pending','claimed') AND NOT EXISTS (
          SELECT 1 FROM mint_tasks task
          WHERE task.user_id=checkpoint.user_id AND task.id=checkpoint.task_id
            AND task.status IN ('scheduled','retry')
            AND task.preflight_generation=checkpoint.generation
            AND task.preflight_target_at=checkpoint.target_at
            AND task.preflight_target_at>TO_TIMESTAMP($1 / 1000.0)
        )`,[now]);
      const tasks=await client.query(`INSERT INTO mint_task_preflight_checks
          (user_id,task_id,generation,target_at,checkpoint,due_at)
        SELECT task.user_id,task.id,task.preflight_generation,task.preflight_target_at,
          schedule.checkpoint,task.preflight_target_at-schedule.lead
        FROM mint_tasks task
        CROSS JOIN (VALUES ('five_minute'::TEXT,INTERVAL '5 minutes'),
          ('thirty_second'::TEXT,INTERVAL '30 seconds')) AS schedule(checkpoint,lead)
        WHERE task.status IN ('scheduled','retry')
          AND task.preflight_target_at>TO_TIMESTAMP($1 / 1000.0)
          AND (schedule.checkpoint<>'five_minute'
            OR task.preflight_target_at>TO_TIMESTAMP($1 / 1000.0)+INTERVAL '30 seconds')
        ON CONFLICT (user_id,task_id,generation,checkpoint) DO UPDATE SET
          target_at=EXCLUDED.target_at,due_at=EXCLUDED.due_at,state='pending',result=NULL,reason=NULL,
          mint_value_wei=NULL,estimated_gas_wei=NULL,total_debit_wei=NULL,balance_wei=NULL,
          shortfall_wei=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,checked_at=NULL,
          notification_attempted_at=NULL,notification_error=NULL
        WHERE mint_task_preflight_checks.state='superseded'`,[now]);
      await client.query('COMMIT');
      return tasks.rowCount;
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
  }

  async function claimDue({workerId,now=Date.now(),leaseMs=90_000,limit=20,userId=null,taskId=null}) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const selected=await client.query(`SELECT task.*,
          checkpoint.check_id,checkpoint.generation,checkpoint.target_at,
          checkpoint.checkpoint,checkpoint.due_at,checkpoint.state,
          checkpoint.claimed_by AS checkpoint_claimed_by,
          checkpoint.claimed_at AS checkpoint_claimed_at,
          checkpoint.lease_expires_at AS checkpoint_lease_expires_at
        FROM mint_task_preflight_checks checkpoint
        JOIN mint_tasks task ON task.user_id=checkpoint.user_id AND task.id=checkpoint.task_id
        WHERE (checkpoint.state='pending' OR
            (checkpoint.state='claimed' AND checkpoint.lease_expires_at<=TO_TIMESTAMP($1 / 1000.0)))
          AND checkpoint.due_at<=TO_TIMESTAMP($1 / 1000.0)
          AND checkpoint.target_at>TO_TIMESTAMP($1 / 1000.0)
          AND task.status IN ('scheduled','retry')
          AND task.preflight_generation=checkpoint.generation
          AND task.preflight_target_at=checkpoint.target_at
          AND ($3::UUID IS NULL OR checkpoint.user_id=$3)
          AND ($4::UUID IS NULL OR checkpoint.task_id=$4)
        ORDER BY checkpoint.due_at,checkpoint.check_id
        FOR UPDATE OF checkpoint SKIP LOCKED LIMIT $2`,[now,limit,userId,taskId]);
      if (!selected.rowCount) { await client.query('COMMIT'); return []; }
      const ids=selected.rows.map(row=>String(row.check_id));
      await client.query(`UPDATE mint_task_preflight_checks SET state='claimed',claimed_by=$1,
          claimed_at=TO_TIMESTAMP($2 / 1000.0),lease_expires_at=TO_TIMESTAMP(($2+$3) / 1000.0)
        WHERE check_id=ANY($4::BIGINT[])`,[workerId,now,leaseMs,ids]);
      await client.query('COMMIT');
      return selected.rows.map(row=>({
        check:{...mapCheck({...row,claimed_by:workerId,claimed_at:new Date(now),
          lease_expires_at:new Date(now+leaseMs)}),state:'claimed'},
        task:mapTask(row),
      }));
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
  }

  async function complete(claim,result) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const owned=await client.query(`SELECT * FROM mint_task_preflight_checks
        WHERE check_id=$1 AND state='claimed' AND claimed_by=$2 FOR UPDATE`,
      [claim.check.checkId,claim.check.claimedBy]);
      if (!owned.rowCount) { await client.query('COMMIT'); return {completed:false,cancelled:false}; }
      const taskResult=await client.query(`SELECT status,preflight_generation,preflight_target_at
        FROM mint_tasks WHERE user_id=$1 AND id=$2 FOR UPDATE`,[claim.task.userId,claim.task.id]);
      const taskRow=taskResult.rows[0];
      let current=Boolean(taskRow
        && ACTIVE_TASK_STATUSES.includes(String(taskRow.status||'').toLowerCase())
        && Number(taskRow.preflight_generation)===claim.check.generation
        && time(taskRow.preflight_target_at)===claim.check.targetAt);
      let cancelled=false;
      if (current && result.result==='sold_out') {
        const changed=await client.query(`UPDATE mint_tasks SET status='cancelled',completed_at=NOW()
          WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry')
            AND preflight_generation=$3 AND preflight_target_at=TO_TIMESTAMP($4 / 1000.0)`,
        [claim.task.userId,claim.task.id,claim.check.generation,claim.check.targetAt]);
        current=changed.rowCount>0;cancelled=current;
      }
      const update=current
        ?await client.query(`UPDATE mint_task_preflight_checks SET state='completed',result=$3,
            reason=$4,mint_value_wei=$5,estimated_gas_wei=$6,total_debit_wei=$7,
            balance_wei=$8,shortfall_wei=$9,checked_at=NOW(),claimed_by=NULL,
            claimed_at=NULL,lease_expires_at=NULL
          WHERE check_id=$1 AND claimed_by=$2 AND state='claimed' RETURNING *`,
        [claim.check.checkId,claim.check.claimedBy,result.result,result.reason??null,
          numeric(result.mintValueWei),numeric(result.estimatedGasWei),numeric(result.totalDebitWei),
          numeric(result.balanceWei),numeric(result.shortfallWei)])
        :await client.query(`UPDATE mint_task_preflight_checks SET state='superseded',
            claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
          WHERE check_id=$1 AND claimed_by=$2 AND state='claimed' RETURNING *`,
        [claim.check.checkId,claim.check.claimedBy]);
      await client.query('COMMIT');
      return {completed:current&&update.rowCount>0,cancelled,
        check:update.rowCount?mapCheck(update.rows[0]):null};
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
  }

  async function claimNotifications({workerId,now=Date.now(),leaseMs=90_000,limit=20,userId=null,taskId=null}) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const selected=await client.query(`SELECT task.*,
          checkpoint.check_id,checkpoint.generation,checkpoint.target_at,
          checkpoint.checkpoint,checkpoint.due_at,checkpoint.state AS checkpoint_state,
          checkpoint.result,checkpoint.reason,checkpoint.mint_value_wei,
          checkpoint.estimated_gas_wei,checkpoint.total_debit_wei,checkpoint.balance_wei,
          checkpoint.shortfall_wei,checkpoint.checked_at,checkpoint.notification_attempted_at,
          checkpoint.notification_error,checkpoint.notification_state,
          checkpoint.notification_attempts,checkpoint.notification_next_attempt_at,
          checkpoint.notification_claimed_by,checkpoint.notification_claimed_at,
          checkpoint.notification_lease_expires_at,checkpoint.notification_delivered_at,
          checkpoint.created_at AS checkpoint_created_at
        FROM mint_task_preflight_checks checkpoint
        JOIN mint_tasks task ON task.user_id=checkpoint.user_id AND task.id=checkpoint.task_id
        WHERE checkpoint.state='completed' AND (
          (checkpoint.notification_state='pending'
            AND checkpoint.notification_next_attempt_at<=TO_TIMESTAMP($1 / 1000.0))
          OR (checkpoint.notification_state='claimed'
            AND checkpoint.notification_lease_expires_at<=TO_TIMESTAMP($1 / 1000.0)))
          AND ($3::UUID IS NULL OR checkpoint.user_id=$3)
          AND ($4::UUID IS NULL OR checkpoint.task_id=$4)
        ORDER BY checkpoint.notification_next_attempt_at,checkpoint.check_id
        FOR UPDATE OF checkpoint SKIP LOCKED LIMIT $2`,[now,limit,userId,taskId]);
      if (!selected.rowCount) { await client.query('COMMIT'); return []; }
      const ids=selected.rows.map(row=>String(row.check_id));
      await client.query(`UPDATE mint_task_preflight_checks
        SET notification_state='claimed',notification_claimed_by=$1,
          notification_claimed_at=TO_TIMESTAMP($2 / 1000.0),
          notification_lease_expires_at=TO_TIMESTAMP(($2+$3) / 1000.0),
          notification_attempts=notification_attempts+1
        WHERE check_id=ANY($4::BIGINT[])`,[workerId,now,leaseMs,ids]);
      await client.query('COMMIT');
      return selected.rows.map(row=>({
        task:mapTask(row),
        check:mapCheck({...row,state:row.checkpoint_state,created_at:row.checkpoint_created_at,
          notification_state:'claimed',notification_claimed_by:workerId,
          notification_claimed_at:new Date(now),notification_lease_expires_at:new Date(now+leaseMs),
          notification_attempts:Number(row.notification_attempts||0)+1}),
      }));
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
  }

  async function finishNotification(claim,{error=null,now=Date.now(),retryAt=null,maxAttempts=5}={}) {
    const failed=Boolean(error)&&claim.check.notificationAttempts>=maxAttempts;
    const state=error?(failed?'failed':'pending'):'delivered';
    const nextAttemptAt=error&&!failed?(retryAt??now):now;
    const result=await pool.query(`UPDATE mint_task_preflight_checks SET
        notification_state=$3,notification_attempted_at=TO_TIMESTAMP($4 / 1000.0),
        notification_error=$5,
        notification_next_attempt_at=TO_TIMESTAMP($6 / 1000.0),
        notification_delivered_at=CASE WHEN $3='delivered' THEN TO_TIMESTAMP($4 / 1000.0)
          ELSE notification_delivered_at END,
        notification_claimed_by=NULL,notification_claimed_at=NULL,
        notification_lease_expires_at=NULL
      WHERE check_id=$1 AND notification_state='claimed' AND notification_claimed_by=$2
      RETURNING *`,[claim.check.checkId,claim.check.notificationClaimedBy,state,now,error,nextAttemptAt]);
    return result.rowCount?mapCheck(result.rows[0]):null;
  }

  return {
    sync,claimDue,complete,claimNotifications,finishNotification,
    async recordNotification(checkId,error=null) {
      const result=await pool.query(`UPDATE mint_task_preflight_checks
        SET notification_attempted_at=NOW(),notification_error=$2
        WHERE check_id=$1 AND state='completed' RETURNING *`,[checkId,error]);
      return result.rowCount?mapCheck(result.rows[0]):null;
    },
    async listForTask(userId,taskId) {
      const result=await pool.query(`SELECT * FROM mint_task_preflight_checks
        WHERE user_id=$1 AND task_id=$2
        ORDER BY generation DESC,target_at DESC,
          CASE checkpoint WHEN 'five_minute' THEN 1 ELSE 2 END DESC`,[userId,taskId]);
      return result.rows.map(mapCheck);
    },
  };
}

module.exports={ACTIVE_TASK_STATUSES,CHECKPOINTS,armTaskPreflightRows,
  createScheduledPreflightRepository,mapCheck};
