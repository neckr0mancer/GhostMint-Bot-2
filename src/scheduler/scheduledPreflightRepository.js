const { evaluateScheduleObservation } = require('./scheduleChangePolicy');

const CHECKPOINTS = Object.freeze([
  Object.freeze({ name:'five_minute', leadMs:5 * 60 * 1000 }),
  Object.freeze({ name:'thirty_second', leadMs:30 * 1000 }),
]);
const ACTIVE_TASK_STATUSES = Object.freeze(['scheduled','retry']);
const REVIEW_EXPIRED_REASON='REVIEW_EXPIRED: No decision was received before this schedule\'s safety deadline. Nothing was sent.';

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
    maxAttempts:row.max_attempts,lastError:row.last_error??null,completedAt:time(row.completed_at),
    viaOpenSea:row.via_opensea,
    stageType:row.stage_type ?? null,stageUuid:row.stage_uuid ?? null,
    stageLabel:row.stage_label ?? null,eligibilityMode:row.eligibility_mode ?? 'specific_stage',
    eligibilityDeadline:time(row.eligibility_deadline),phaseWaitCount:Number(row.phase_wait_count||0),
    preflightTargetAt:time(row.preflight_target_at),
    preflightGeneration:Number(row.preflight_generation||1),
    originalOpeningAt:time(row.original_opening_at),acceptedOpeningAt:time(row.accepted_opening_at),
    lastObservedOpeningAt:time(row.last_observed_opening_at),
    timeChangePolicy:row.time_change_policy??'approval',
    maxOpeningDelayMs:row.max_opening_delay_ms===null||row.max_opening_delay_ms===undefined
      ?null:Number(row.max_opening_delay_ms),
    acceptedPriceWeiPerItem:row.accepted_price_wei_per_item===null
      ||row.accepted_price_wei_per_item===undefined?null:String(row.accepted_price_wei_per_item),
    lastObservedPriceWeiPerItem:row.last_observed_price_wei_per_item===null
      ||row.last_observed_price_wei_per_item===undefined?null:String(row.last_observed_price_wei_per_item),
    priceChangePolicy:row.price_change_policy??'approval',
    maxPriceWeiPerItem:row.max_price_wei_per_item===null||row.max_price_wei_per_item===undefined
      ?null:String(row.max_price_wei_per_item),
    acceptedConfigFingerprint:row.accepted_config_fingerprint??null,
    lastObservedConfigFingerprint:row.last_observed_config_fingerprint??null,
    acceptedConfigSummary:row.accepted_config_summary??null,
    lastObservedConfigSummary:row.last_observed_config_summary??null,
    changeState:row.change_state??'clear',changeVersion:Number(row.change_version||0),
    pendingChange:row.pending_change??null,changeDetectedAt:time(row.change_detected_at),
    changeReviewExpiresAt:time(row.change_review_expires_at),
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
    notificationDeliveredAt:time(row.notification_delivered_at),
    scheduleChangeAction:row.schedule_change_action??null,
    scheduleChangeVersion:row.schedule_change_version===null||row.schedule_change_version===undefined
      ?null:Number(row.schedule_change_version),
    scheduleChangeReason:row.schedule_change_reason??null,createdAt:time(row.created_at),
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
      notification_attempted_at=NULL,notification_error=NULL,schedule_change_action=NULL,
      schedule_change_version=NULL,schedule_change_reason=NULL
    WHERE mint_task_preflight_checks.state='superseded'`,
  [row.user_id,row.id,generation,targetAt]);
}

function createScheduledPreflightRepository(pool) {
  async function expireAwaitingReviews(client,{now=Date.now(),limit=20,userId=null,taskId=null}={}) {
    const selected=await client.query(`SELECT * FROM mint_tasks
      WHERE status='paused' AND change_state='awaiting_approval'
        AND change_review_expires_at IS NOT NULL
        AND change_review_expires_at<=TO_TIMESTAMP($1 / 1000.0)
        AND ($3::UUID IS NULL OR user_id=$3)
        AND ($4::UUID IS NULL OR id=$4)
      ORDER BY change_review_expires_at,id
      FOR UPDATE SKIP LOCKED LIMIT $2`,[now,limit,userId,taskId]);
    const expired=[];
    for(const row of selected.rows){
      const updated=await client.query(`UPDATE mint_tasks SET status='failed',change_state='clear',
          pending_change=NULL,change_review_expires_at=NULL,last_error=$3,
          completed_at=TO_TIMESTAMP($4 / 1000.0),
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
        WHERE user_id=$1 AND id=$2 AND status='paused' AND change_state='awaiting_approval'
        RETURNING *`,[row.user_id,row.id,REVIEW_EXPIRED_REASON,now]);
      if(!updated.rowCount)continue;
      const saved=updated.rows[0];
      await client.query(`UPDATE mint_task_change_events SET action='expired',resolved_at=TO_TIMESTAMP($4 / 1000.0)
        WHERE user_id=$1 AND task_id=$2 AND change_version=$3 AND action='awaiting_approval'`,
      [row.user_id,row.id,row.change_version,now]);
      await client.query(`UPDATE mint_task_preflight_checks SET state='superseded',
          claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
        WHERE user_id=$1 AND task_id=$2 AND state IN ('pending','claimed')`,[row.user_id,row.id]);
      await client.query(`INSERT INTO mint_task_preflight_checks
          (user_id,task_id,generation,target_at,checkpoint,due_at,state,result,reason,checked_at,
           schedule_change_action,schedule_change_version,schedule_change_reason)
        VALUES ($1,$2,$3,TO_TIMESTAMP($4 / 1000.0),'change_review_expiry',
          TO_TIMESTAMP($5 / 1000.0),'completed','review_expired',$6,
          TO_TIMESTAMP($5 / 1000.0),'expired',$7,$6)
        ON CONFLICT (user_id,task_id,generation,checkpoint) DO NOTHING`,
      [row.user_id,row.id,row.preflight_generation,time(row.change_review_expires_at)??now,now,
        REVIEW_EXPIRED_REASON,row.change_version]);
      expired.push(mapTask(saved));
    }
    return expired;
  }

  async function expirePendingReviews(options={}) {
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const expired=await expireAwaitingReviews(client,options);
      await client.query('COMMIT');
      return expired;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }

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
          notification_attempted_at=NULL,notification_error=NULL,schedule_change_action=NULL,
          schedule_change_version=NULL,schedule_change_reason=NULL
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
      const taskResult=await client.query(`SELECT *
        FROM mint_tasks WHERE user_id=$1 AND id=$2 FOR UPDATE`,[claim.task.userId,claim.task.id]);
      const taskRow=taskResult.rows[0];
      let current=Boolean(taskRow
        && ACTIVE_TASK_STATUSES.includes(String(taskRow.status||'').toLowerCase())
        && Number(taskRow.preflight_generation)===claim.check.generation
        && time(taskRow.preflight_target_at)===claim.check.targetAt);
      let cancelled=false;
      let failed=false;
      let scheduleEvaluation=null;
      let savedTaskRow=taskRow;
      if (current && result.result==='sold_out') {
        const soldOutReason='SOLD_OUT: The collection or selected stage sold out before this scheduled mint could run. Nothing was sent.';
        const changed=await client.query(`UPDATE mint_tasks SET status='failed',completed_at=NOW(),
            last_error=$5,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
          WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry')
            AND preflight_generation=$3 AND preflight_target_at=TO_TIMESTAMP($4 / 1000.0)
          RETURNING *`,
        [claim.task.userId,claim.task.id,claim.check.generation,claim.check.targetAt,soldOutReason]);
        current=changed.rowCount>0;failed=current;
        if(changed.rowCount)savedTaskRow=changed.rows[0];
      } else if(current&&result.scheduleObservation) {
        scheduleEvaluation=evaluateScheduleObservation(mapTask(taskRow),result.scheduleObservation,
          {now:Date.now()});
        const action=scheduleEvaluation.action;
        if(['accepted','auto_rescheduled','awaiting_approval','expired'].includes(action)){
          const observed=scheduleEvaluation.observed||{};
          const version=Number(taskRow.change_version||0)+1;
          const pending=action==='awaiting_approval'?{...scheduleEvaluation,version}:null;
          const movedOpening=Number.isFinite(Number(observed.openingAt))?Number(observed.openingAt):null;
          const currentAttempt=time(taskRow.next_attempt_at??taskRow.mint_time);
          const rescheduledTarget=action==='auto_rescheduled'&&movedOpening!==null
            ?Math.max(movedOpening,currentAttempt??movedOpening):movedOpening;
          const nextStatus=action==='auto_rescheduled'?'retry'
            :action==='awaiting_approval'?'paused':action==='expired'?'failed':taskRow.status;
          const changed=await client.query(`UPDATE mint_tasks SET status=$5,
              mint_time=CASE WHEN $6 AND $7::BIGINT IS NOT NULL THEN TO_TIMESTAMP($7 / 1000.0) ELSE mint_time END,
              next_attempt_at=CASE WHEN $6 AND $7::BIGINT IS NOT NULL THEN TO_TIMESTAMP($7 / 1000.0) ELSE next_attempt_at END,
              accepted_opening_at=CASE WHEN $9 AND $8::BIGINT IS NOT NULL THEN TO_TIMESTAMP($8 / 1000.0) ELSE accepted_opening_at END,
              last_observed_opening_at=CASE WHEN $8::BIGINT IS NULL THEN last_observed_opening_at ELSE TO_TIMESTAMP($8 / 1000.0) END,
              accepted_price_wei_per_item=CASE WHEN $9 AND $10::NUMERIC IS NOT NULL THEN $10::NUMERIC ELSE accepted_price_wei_per_item END,
              last_observed_price_wei_per_item=COALESCE($10::NUMERIC,last_observed_price_wei_per_item),
              accepted_config_fingerprint=CASE WHEN $9 AND $11::TEXT IS NOT NULL AND $12::JSONB IS NOT NULL THEN $11 ELSE accepted_config_fingerprint END,
              last_observed_config_fingerprint=CASE WHEN $11::TEXT IS NOT NULL AND $12::JSONB IS NOT NULL THEN $11 ELSE last_observed_config_fingerprint END,
              accepted_config_summary=CASE WHEN $9 AND $11::TEXT IS NOT NULL AND $12::JSONB IS NOT NULL THEN $12::JSONB ELSE accepted_config_summary END,
              last_observed_config_summary=CASE WHEN $11::TEXT IS NOT NULL AND $12::JSONB IS NOT NULL THEN $12::JSONB ELSE last_observed_config_summary END,
              change_state=CASE WHEN $13 THEN 'awaiting_approval' ELSE 'clear' END,
              change_version=$14,pending_change=$15::JSONB,change_detected_at=NOW(),
              change_review_expires_at=CASE WHEN $13 THEN
                LEAST(COALESCE(eligibility_deadline,'infinity'::TIMESTAMPTZ),NOW()+INTERVAL '24 hours')
                ELSE NULL END,
              last_error=CASE WHEN $16 THEN $17 ELSE last_error END,
              preflight_target_at=CASE WHEN $6 AND $7::BIGINT IS NOT NULL THEN TO_TIMESTAMP($7 / 1000.0) ELSE preflight_target_at END,
              preflight_generation=preflight_generation+CASE WHEN $6 THEN 1 ELSE 0 END,
              completed_at=CASE WHEN $5='failed' THEN NOW() ELSE completed_at END
            WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','retry')
              AND preflight_generation=$3 AND preflight_target_at=TO_TIMESTAMP($4 / 1000.0)
            RETURNING *`,[claim.task.userId,claim.task.id,claim.check.generation,claim.check.targetAt,
            nextStatus,action==='auto_rescheduled',rescheduledTarget,movedOpening,
            action==='accepted'||action==='auto_rescheduled',observed.priceWeiPerItem??null,
            observed.configFingerprint??null,observed.configSummary?JSON.stringify(observed.configSummary):null,
            action==='awaiting_approval',version,pending?JSON.stringify(pending):null,
            action!=='accepted',scheduleEvaluation.reason||null]);
          current=changed.rowCount>0;
          if(current){
            savedTaskRow=changed.rows[0];
            await client.query(`INSERT INTO mint_task_change_events
                (user_id,task_id,change_version,event_fingerprint,kinds,action,
                 previous_snapshot,observed_snapshot,reason)
              VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9)
              ON CONFLICT (user_id,task_id,change_version) DO NOTHING`,
            [claim.task.userId,claim.task.id,version,scheduleEvaluation.eventFingerprint,
              scheduleEvaluation.kinds,action,JSON.stringify(scheduleEvaluation.previous),
              JSON.stringify(observed),scheduleEvaluation.reason]);
          }
        }
      }
      const scheduleAction=scheduleEvaluation?.action;
      const persistedScheduleAction=['accepted','auto_rescheduled','awaiting_approval','expired']
        .includes(scheduleAction)?scheduleAction:null;
      const notifyScheduleAction=persistedScheduleAction==='accepted'
        &&scheduleEvaluation.kinds.every(kind=>kind==='configuration_baseline')
        ?null:persistedScheduleAction;
      const update=current
        ?await client.query(`UPDATE mint_task_preflight_checks SET state='completed',result=$3,
            reason=$4,mint_value_wei=$5,estimated_gas_wei=$6,total_debit_wei=$7,
            balance_wei=$8,shortfall_wei=$9,checked_at=NOW(),claimed_by=NULL,
            claimed_at=NULL,lease_expires_at=NULL,schedule_change_action=$10,
            schedule_change_version=$11,schedule_change_reason=$12
          WHERE check_id=$1 AND claimed_by=$2 AND state='claimed' RETURNING *`,
        [claim.check.checkId,claim.check.claimedBy,result.result,result.reason??null,
          numeric(result.mintValueWei),numeric(result.estimatedGasWei),numeric(result.totalDebitWei),
          numeric(result.balanceWei),numeric(result.shortfallWei),notifyScheduleAction??null,
          scheduleEvaluation&&scheduleEvaluation.action!=='unchanged'
            ?Number(savedTaskRow?.change_version||0):null,scheduleEvaluation?.reason??null])
        :await client.query(`UPDATE mint_task_preflight_checks SET state='superseded',
            claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
          WHERE check_id=$1 AND claimed_by=$2 AND state='claimed' RETURNING *`,
        [claim.check.checkId,claim.check.claimedBy]);
      if(current&&scheduleAction==='auto_rescheduled')await armTaskPreflightRows(client,savedTaskRow);
      await client.query('COMMIT');
      return {completed:current&&update.rowCount>0,cancelled,failed,
        check:update.rowCount?mapCheck(update.rows[0]):null,
        task:savedTaskRow?mapTask(savedTaskRow):null,scheduleChange:scheduleEvaluation};
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
          checkpoint.schedule_change_action,checkpoint.schedule_change_version,
          checkpoint.schedule_change_reason,
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
    sync,claimDue,complete,claimNotifications,finishNotification,expirePendingReviews,
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

module.exports={ACTIVE_TASK_STATUSES,CHECKPOINTS,REVIEW_EXPIRED_REASON,armTaskPreflightRows,
  createScheduledPreflightRepository,mapCheck};
