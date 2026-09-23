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
    wallet_address:'0x0000000000000000000000000000000000000002',
    reservation_stage_key:'uuid:old-stage',allowance_scope:'unknown',
    allowance_max_per_wallet:null,allowance_minted_snapshot:null,allowance_source:null,
    allowance_verified_at:null,allowance_stage_start_at:new Date('2026-08-25T12:00:00.000Z'),
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

test('migration 061 adds active stage reservations without rewriting historical stage identities',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations','061_schedule_stage_reservations.sql'),'utf8');
  assert.match(sql,/ADD COLUMN wallet_address TEXT/);
  assert.match(sql,/ADD COLUMN reservation_stage_key TEXT/);
  assert.match(sql,/status IN \('scheduled','claimed','retry','paused'\)/);
  assert.match(sql,/CREATE UNIQUE INDEX mint_tasks_active_wallet_contract_stage_uniq/);
  assert.doesNotMatch(sql,/SET reservation_stage_key=/,
    'historical duplicate tasks must not be silently collapsed or made migration-blocking');
});

test('Postgres storage persists phase eligibility fields and maps them on reads', async () => {
  let insert;
  // Keep this row in the pre-reservation shape so the mapper's conservative legacy defaults stay
  // covered independently from the phase-move tests below.
  const row = taskRow({wallet_address:null,reservation_stage_key:null,
    allowance_stage_start_at:null});
  const query=async(sql,params)=>{
      if (sql.includes('INSERT INTO mint_tasks')) {
        insert = { sql, params };
        return { rowCount:1, rows:[{ id:row.id }] };
      }
      if (sql.includes('FROM mint_tasks')) return { rows:[row] };
      return { rows:[] };
  };
  const pool = {
    query,
    async connect(){return {query,release(){}};},
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
  assert.deepEqual(insert.params.slice(18,22), ['new-stage','Allowlist round','earliest_eligible',deadline]);
  assert.match(insert.sql,/wallet_address,reservation_stage_key/);

  const mapped = (await storage.loadState(row.user_id)).tasks[0];
  assert.equal(mapped.stageUuid, 'old-stage');
  assert.equal(mapped.stageLabel, 'Old stage');
  assert.equal(mapped.eligibilityMode, 'earliest_eligible');
  assert.equal(mapped.eligibilityDeadline, row.eligibility_deadline.getTime());
  assert.equal(mapped.phaseWaitCount, 0);
  assert.equal(mapped.walletAddress, null);
  assert.equal(mapped.reservationStageKey, null);
});

function phaseRepositoryFixture(updatedRow,{activeRows=[]}={}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COALESCE(NULLIF(task.wallet_address')) {
        const source=updatedRow||taskRow();
        return {rowCount:1,rows:[{wallet_address:source.wallet_address,
          chain:source.chain,contract_address:source.contract_address}]};
      }
      if (sql.includes('SELECT active_task.*')) return {rowCount:activeRows.length,rows:activeRows};
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

function claimedTask(row=taskRow()) {
  return {
    userId:row.user_id,id:row.id,attemptCount:row.attempt_count,maxAttempts:row.max_attempts,
    walletLabel:row.wallet_label,walletAddress:row.wallet_address,chain:row.chain,
    contract:row.contract_address,qty:row.quantity,mintTime:row.mint_time.getTime(),
    stageUuid:row.stage_uuid,stageLabel:row.stage_label,stageType:row.stage_type,
    reservationStageKey:row.reservation_stage_key,
  };
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

  const result = await repository.deferForPhase(claimedTask(claimed), {
    retryAt,mintTime:retryAt,deadline,stageUuid:'public-stage',stageLabel:'Public sale',stageType:'public_sale',
    allowanceEvidence:{allowanceScope:'contract_cumulative',allowanceMaxPerWallet:'10',
      allowanceMintedSnapshot:'2',allowanceSource:'seadrop:PublicDrop+getMintStats',
      allowanceVerifiedAt:retryAt,allowanceStageStartAt:retryAt},
    reason:'waiting for an eligible public phase',
  });

  assert.equal(result.status, 'retry');
  assert.equal(result.mintTime, retryAt);
  assert.equal(result.nextAttemptAt, retryAt);
  assert.equal(result.stageUuid, 'public-stage');
  assert.equal(result.eligibilityDeadline, deadline);
  assert.equal(result.phaseWaitCount, 1);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[2].sql,/pg_advisory_xact_lock/);
  assert.match(calls[3].sql,/FOR UPDATE OF active_task/);
  const update = calls.find(call => call.sql.includes('UPDATE mint_tasks SET'));
  assert.match(update.sql, /WHERE user_id=\$1 AND id=\$2 AND status='claimed' AND attempt_count=\$3/);
  assert.doesNotMatch(update.sql, /max_attempts/);
  assert.match(update.sql, /phase_wait_count=phase_wait_count\+1/);
  assert.match(update.sql,/reservation_stage_key=CASE WHEN \$16 THEN \$17/);
  assert.match(update.sql,/allowance_scope=CASE WHEN \$16 THEN \$18/);
  assert.deepEqual(update.params.slice(17,23),['contract_cumulative','10','2',
    'seadrop:PublicDrop+getMintStats',retryAt,retryAt]);
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

test('phase advance rolls back when it would exceed a proven later cumulative boundary',async()=>{
  const claimed=taskRow({quantity:2});
  const laterBoundary=taskRow({
    id:'00000000-0000-4000-8000-000000000099',status:'scheduled',quantity:7,
    mint_time:new Date('2026-08-25T14:00:00.000Z'),stage_uuid:'later-public',
    stage_label:'Later public',stage_type:'public_sale',reservation_stage_key:'uuid:later-public',
    allowance_scope:'contract_cumulative',allowance_max_per_wallet:'10',
    allowance_minted_snapshot:'2',allowance_stage_start_at:new Date('2026-08-25T14:00:00.000Z'),
  });
  const {calls,repository}=phaseRepositoryFixture(null,{activeRows:[laterBoundary]});
  await assert.rejects(repository.deferForPhase(claimedTask(claimed),{
    retryAt:Date.parse('2026-08-25T12:10:00.000Z'),
    mintTime:Date.parse('2026-08-25T12:10:00.000Z'),stageUuid:'allowlist-next',
    stageLabel:'Next allowlist',stageType:'allowlist',
    allowanceEvidence:{allowanceScope:'unknown',allowanceMintedSnapshot:'2',
      allowanceSource:'seadrop:getMintStats',allowanceVerifiedAt:Date.now(),
      allowanceStageStartAt:Date.parse('2026-08-25T12:10:00.000Z')},
    reason:'moving to the next stage',
  }),error=>error.code==='SCHEDULE_ALLOWANCE_EXCEEDED'&&error.details.remaining==='1');
  assert.equal(calls.some(call=>call.sql.includes('UPDATE mint_tasks SET')),false,
    'the persisted stage must not move when the new envelope is over capacity');
  assert.equal(calls.at(-2).sql,'ROLLBACK');
  assert.equal(calls.at(-1).sql,'RELEASE');
});
