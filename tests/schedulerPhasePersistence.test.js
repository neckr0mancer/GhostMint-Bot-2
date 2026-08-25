const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createSchedulerRepository } = require('../src/scheduler/schedulerRepository');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

function taskRow(overrides = {}) {
  return {
    id:'00000000-0000-4000-8000-000000000001',
    user_id:'00000000-0000-4000-8000-000000000002',
    name:'phase-aware mint',wallet_label:'primary',
    contract_address:'0x0000000000000000000000000000000000000001',function_name:'mint',
    quantity:1,price_eth:'0',gas_gwei:null,chain:'ethereum',
    mint_time:new Date('2026-08-25T12:00:00.000Z'),status:'claimed',
    created_at:new Date('2026-08-24T12:00:00.000Z'),
    next_attempt_at:new Date('2026-08-25T12:00:00.000Z'),attempt_count:2,max_attempts:1,
    claimed_by:'worker-a',claimed_at:new Date('2026-08-25T12:00:00.000Z'),
    lease_expires_at:new Date('2026-08-25T12:01:00.000Z'),transaction_intent_id:null,
    idempotency_key:'scheduled-mint:test',last_error:null,completed_at:null,via_opensea:true,
    stage_type:'allowlist',stage_uuid:'old-stage',stage_label:'Old stage',
    eligibility_mode:'earliest_eligible',eligibility_deadline:new Date('2026-08-26T12:00:00.000Z'),
    phase_wait_count:0,
    ...overrides,
  };
}

test('migration 053 adds constrained durable phase metadata with a conservative database default', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '053_task_phase_eligibility.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN stage_uuid TEXT/);
  assert.match(sql, /ADD COLUMN stage_label TEXT/);
  assert.match(sql, /eligibility_mode TEXT NOT NULL DEFAULT 'specific_stage'/);
  assert.match(sql, /eligibility_mode IN \('specific_stage','earliest_eligible'\)/);
  assert.match(sql, /ADD COLUMN eligibility_deadline TIMESTAMPTZ/);
});

test('migration 054 separates phase-only waits from the execution retry budget', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '054_task_phase_wait_count.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN phase_wait_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /phase_wait_count <= attempt_count/);
});

test('Postgres storage persists phase eligibility fields and maps them on reads', async () => {
  let insert;
  const row = taskRow();
  const pool = {
    async query(sql, params) {
      if (sql.includes('INSERT INTO mint_tasks')) {
        insert = { sql, params };
        return { rowCount:1, rows:[{ id:row.id }] };
      }
      if (sql.includes('FROM mint_tasks')) return { rows:[row] };
      return { rows:[] };
    },
  };
  const storage = createPostgresStorage(pool);
  const deadline = Date.parse('2026-08-26T12:00:00.000Z');
  await storage.saveTask({
    userId:row.user_id,id:row.id,name:row.name,walletLabel:row.wallet_label,
    contract:row.contract_address,fn:'mint',qty:1,price:0,gas:null,chain:'ethereum',
    mintTime:row.mint_time.getTime(),status:'scheduled',createdAt:row.created_at.getTime(),
    nextAttemptAt:row.next_attempt_at.getTime(),maxAttempts:3,viaOpenSea:true,stageType:'allowlist',
    stageUuid:'new-stage',stageLabel:'Allowlist round',eligibilityMode:'earliest_eligible',
    eligibilityDeadline:deadline,
  });

  assert.match(insert.sql, /stage_uuid,stage_label/);
  assert.match(insert.sql, /eligibility_mode,eligibility_deadline/);
  assert.deepEqual(insert.params.slice(18), ['new-stage','Allowlist round','earliest_eligible',deadline]);

  const mapped = (await storage.loadState(row.user_id)).tasks[0];
  assert.equal(mapped.stageUuid, 'old-stage');
  assert.equal(mapped.stageLabel, 'Old stage');
  assert.equal(mapped.eligibilityMode, 'earliest_eligible');
  assert.equal(mapped.eligibilityDeadline, row.eligibility_deadline.getTime());
  assert.equal(mapped.phaseWaitCount, 0);
});

function phaseRepositoryFixture(updatedRow) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE mint_tasks SET')) {
        return updatedRow ? { rowCount:1, rows:[updatedRow] } : { rowCount:0, rows:[] };
      }
      return { rowCount:1, rows:[] };
    },
    release() { calls.push({ sql:'RELEASE' }); },
  };
  const pool = { async connect() { return client; } };
  return { calls, repository:createSchedulerRepository(pool) };
}

test('deferForPhase atomically re-arms a claimed task and records retry without consulting maxAttempts', async () => {
  const retryAt = Date.parse('2026-08-25T12:10:00.000Z');
  const deadline = Date.parse('2026-08-25T13:00:00.000Z');
  const claimed = taskRow();
  const updated = taskRow({
    status:'retry',mint_time:new Date(retryAt),next_attempt_at:new Date(retryAt),
    stage_uuid:'public-stage',stage_label:'Public sale',stage_type:'public_sale',
    eligibility_deadline:new Date(deadline),claimed_by:null,claimed_at:null,lease_expires_at:null,
    phase_wait_count:1,
  });
  const { calls, repository } = phaseRepositoryFixture(updated);

  const result = await repository.deferForPhase({
    userId:claimed.user_id,id:claimed.id,attemptCount:claimed.attempt_count,maxAttempts:claimed.max_attempts,
  }, {
    retryAt,mintTime:retryAt,deadline,stageUuid:'public-stage',stageLabel:'Public sale',stageType:'public_sale',
    reason:'waiting for an eligible public phase',
  });

  assert.equal(result.status, 'retry');
  assert.equal(result.mintTime, retryAt);
  assert.equal(result.nextAttemptAt, retryAt);
  assert.equal(result.stageUuid, 'public-stage');
  assert.equal(result.eligibilityDeadline, deadline);
  assert.equal(result.phaseWaitCount, 1);
  assert.equal(calls[0].sql, 'BEGIN');
  const update = calls.find(call => call.sql.includes('UPDATE mint_tasks SET'));
  assert.match(update.sql, /WHERE user_id=\$1 AND id=\$2 AND status='claimed' AND attempt_count=\$3/);
  assert.doesNotMatch(update.sql, /max_attempts/);
  assert.match(update.sql, /phase_wait_count=phase_wait_count\+1/);
  assert.equal(update.params[3], retryAt);
  const audit = calls.find(call => call.sql.includes('UPDATE mint_task_attempts'));
  assert.equal(audit.params[3], 'retry');
  assert.equal(audit.params[4], 'waiting for an eligible public phase');
  assert.equal(calls.at(-2).sql, 'COMMIT');
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('deferForPhase does not audit when the claimed ownership/status/attempt guard loses', async () => {
  const { calls, repository } = phaseRepositoryFixture(null);
  const result = await repository.deferForPhase({
    userId:'00000000-0000-4000-8000-000000000002',
    id:'00000000-0000-4000-8000-000000000001',attemptCount:4,
  }, { retryAt:Date.now() + 60_000, reason:'waiting for eligibility' });

  assert.equal(result, null);
  assert.equal(calls.some(call => call.sql.includes('UPDATE mint_task_attempts')), false);
  const update = calls.find(call => call.sql.includes('UPDATE mint_tasks SET'));
  assert.equal(update.params[4], false, 'an omitted mintTime must preserve the user-facing phase time');
  assert.equal(update.params[6], false, 'an omitted deadline must preserve the stored deadline');
  assert.equal(calls.at(-2).sql, 'COMMIT');
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('phase-only claims do not exhaust a later real transient execution retry', async () => {
  const { calls, repository } = phaseRepositoryFixture(taskRow());
  const outcome = await repository.fail({
    userId:'00000000-0000-4000-8000-000000000002',
    id:'00000000-0000-4000-8000-000000000001',attemptCount:10,phaseWaitCount:9,maxAttempts:3,
  }, { reason:'RPC temporarily unavailable', transient:true, retryAt:Date.now() + 5_000 });
  assert.equal(outcome, 'retry');
  const update = calls.find(call => call.sql.includes('UPDATE mint_tasks SET'));
  assert.equal(update.params[2], 'retry');
});
