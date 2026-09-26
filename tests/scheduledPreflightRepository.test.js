const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {armTaskPreflightRows,createScheduledPreflightRepository}=require('../src/scheduler/scheduledPreflightRepository');

test('migration 062 defines generation-safe durable 5-minute and 30-second checks',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations','062_durable_schedule_preflights.sql'),'utf8');
  assert.match(sql,/ADD COLUMN preflight_target_at TIMESTAMPTZ/);
  assert.match(sql,/ADD COLUMN preflight_generation INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql,/CREATE TABLE mint_task_preflight_checks/);
  assert.match(sql,/checkpoint IN \('five_minute','thirty_second'\)/);
  assert.match(sql,/result IS NULL OR result IN[\s\S]*'ready','short','price_unknown','sold_out','check_failed'/);
  const repository=fs.readFileSync(path.join(__dirname,'..','src','scheduler','scheduledPreflightRepository.js'),'utf8');
  assert.match(repository,/FOR UPDATE OF checkpoint SKIP LOCKED/);
});

test('migration 063 and repository provide a bounded, lease-recoverable notification outbox',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations',
    '063_durable_schedule_preflight_notifications.sql'),'utf8');
  assert.match(sql,/notification_state IN \('pending','claimed','delivered','failed'\)/);
  assert.match(sql,/notification_attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql,/notification_lease_expires_at/);
  const repository=fs.readFileSync(path.join(__dirname,'..','src','scheduler',
    'scheduledPreflightRepository.js'),'utf8');
  assert.match(repository,/async function claimNotifications/);
  assert.match(repository,/checkpoint\.notification_state='claimed'[\s\S]*notification_lease_expires_at<=/);
  assert.match(repository,/FOR UPDATE OF checkpoint SKIP LOCKED/);
  assert.match(repository,/notificationAttempts>=maxAttempts/);
});

test('migration 065 carries schedule-change decisions through the same durable preflight outbox',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations',
    '065_schedule_change_policies.sql'),'utf8');
  assert.match(sql,/ADD COLUMN schedule_change_action TEXT/);
  assert.match(sql,/schedule_change_version INTEGER/);
  assert.match(sql,/UNIQUE \(user_id,task_id,change_version\)/);
  assert.match(sql,/mint_tasks_change_state_shape/);
  assert.match(sql,/ADD COLUMN change_review_expires_at TIMESTAMPTZ/);
  assert.match(sql,/change_review_expires_at IS NOT NULL/);
  assert.match(sql,/change_review_expiry/);
  assert.match(sql,/review_expired/);
  const repository=fs.readFileSync(path.join(__dirname,'..','src','scheduler',
    'scheduledPreflightRepository.js'),'utf8');
  assert.match(repository,/evaluateScheduleObservation/);
  assert.match(repository,/schedule_change_action=\$10/);
  assert.match(repository,/await armTaskPreflightRows\(client,savedTaskRow\)/);
  assert.match(repository,/async function expirePendingReviews/);
  assert.match(repository,/AND change_review_expires_at<=/);
  assert.match(repository,/NOW\(\)\+INTERVAL '24 hours'/);
  assert.match(repository,/FOR UPDATE SKIP LOCKED LIMIT \$2/);
  assert.match(repository,/status='failed',change_state='clear'/);
  assert.match(repository,/ON CONFLICT \(user_id,task_id,generation,checkpoint\) DO NOTHING/);
});

test('migration 066 repairs a previously recorded 065 without rewriting migration history',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations',
    '066_repair_schedule_review_deadline.sql'),'utf8');
  assert.match(sql,/ADD COLUMN IF NOT EXISTS change_review_expires_at TIMESTAMPTZ/);
  assert.match(sql,/change_state='awaiting_approval'/);
  assert.match(sql,/COALESCE\(change_detected_at,NOW\(\)\)\+INTERVAL '24 hours'/);
  assert.match(sql,/mint_tasks_change_review_deadline_shape/);
  assert.match(sql,/pg_indexes/);
  assert.match(sql,/CREATE INDEX mint_tasks_change_review_deadline_idx/);
});

test('migration 067 adds exact same-stage time following without widening legacy schedules',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations',
    '067_auto_follow_schedule_stage.sql'),'utf8');
  assert.match(sql,/auto_follow_stage/);
  assert.match(sql,/auto_within_limit/);
  assert.match(sql,/DROP CONSTRAINT IF EXISTS mint_tasks_time_change_policy_check/);
  const preflight=fs.readFileSync(path.join(__dirname,'..','src','scheduler',
    'scheduledPreflightRepository.js'),'utf8');
  assert.match(preflight,/eligibility_deadline=CASE WHEN \$6 AND \$18::BIGINT IS NOT NULL/);
  assert.match(preflight,/taskRow\.time_change_policy==='auto_follow_stage'/);
  const scheduler=fs.readFileSync(path.join(__dirname,'..','src','scheduler',
    'schedulerRepository.js'),'utf8');
  assert.match(scheduler,/eligibility_deadline=CASE WHEN \$5 AND \$18::BIGINT IS NOT NULL/);
  assert.match(scheduler,/task\.timeChangePolicy==='auto_follow_stage'/);
});

test('arming uses the task generation and creates both checkpoints in the caller transaction',async()=>{
  const calls=[];const queryable={query:async(sql,params)=>{calls.push({sql,params});return {rows:[],rowCount:0};}};
  await armTaskPreflightRows(queryable,{user_id:'user-1',id:'task-1',status:'scheduled',
    preflight_target_at:new Date(Date.now()+600_000),preflight_generation:3});
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/generation<>\$3/);
  assert.match(calls[1].sql,/five_minute/);assert.match(calls[1].sql,/thirty_second/);
  assert.deepEqual(calls[1].params.slice(0,3),['user-1','task-1',3]);
});

test('preflight history reads are user and task scoped',async()=>{
  const calls=[];const pool={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{
    check_id:'9',user_id:'user-1',task_id:'task-1',generation:2,
    target_at:new Date('2026-09-14T10:00:00Z'),checkpoint:'thirty_second',
    due_at:new Date('2026-09-14T09:59:30Z'),state:'completed',result:'short',
    reason:'The wallet balance is below the current estimated debit.',mint_value_wei:'1',
    estimated_gas_wei:'2',total_debit_wei:'3',balance_wei:'2',shortfall_wei:'1',
    checked_at:new Date('2026-09-14T09:59:30Z'),created_at:new Date('2026-09-14T09:00:00Z'),
  }]};}};
  const rows=await createScheduledPreflightRepository(pool).listForTask('user-1','task-1');
  assert.deepEqual(calls[0].params,['user-1','task-1']);
  assert.match(calls[0].sql,/WHERE user_id=\$1 AND task_id=\$2/);
  assert.equal(rows[0].result,'short');assert.equal(rows[0].shortfallWei,'1');
});

test('claimDue maps stage reservation and allowance evidence onto the claimed task',async()=>{
  const now=Date.parse('2026-09-25T12:00:00Z');
  const row={check_id:'9',user_id:'11111111-1111-4111-8111-111111111111',
    task_id:'22222222-2222-4222-8222-222222222222',id:'22222222-2222-4222-8222-222222222222',
    generation:2,target_at:new Date(now+60_000),checkpoint:'thirty_second',
    due_at:new Date(now-1_000),state:'pending',status:'scheduled',preflight_generation:2,
    preflight_target_at:new Date(now+60_000),reservation_stage_key:'stage:public',
    allowance_scope:'contract_cumulative',allowance_max_per_wallet:'10',allowance_minted_snapshot:'3',
    allowance_source:'opensea',allowance_verified_at:new Date(now-5_000),
    allowance_stage_start_at:new Date(now+60_000)};
  const client={release(){},query:async sql=>{
    if(/SELECT task\.\*/.test(sql))return {rows:[row],rowCount:1};
    return {rows:[],rowCount:0};
  }};
  const claims=await createScheduledPreflightRepository({connect:async()=>client})
    .claimDue({workerId:'worker-1',now,limit:1});
  assert.equal(claims[0].task.reservationStageKey,'stage:public');
  assert.equal(claims[0].task.allowanceScope,'contract_cumulative');
  assert.equal(claims[0].task.allowanceMaxPerWallet,'10');
  assert.equal(claims[0].task.allowanceMintedSnapshot,'3');
  assert.equal(claims[0].task.allowanceSource,'opensea');
  assert.equal(claims[0].task.allowanceVerifiedAt,now-5_000);
  assert.equal(claims[0].task.allowanceStageStartAt,now+60_000);
});
