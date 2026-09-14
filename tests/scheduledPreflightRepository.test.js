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
