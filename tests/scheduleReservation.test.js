'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createPostgresStorage}=require('../src/storage/postgresStorage');

const row=(overrides={})=>({
  user_id:'11111111-1111-4111-8111-111111111111',id:'22222222-2222-4222-8222-222222222222',
  name:'Public',wallet_label:'main',wallet_address:'0x0000000000000000000000000000000000000001',
  contract_address:'0x0000000000000000000000000000000000000002',function_name:'mint',quantity:1,
  price_eth:'0',gas_gwei:null,chain:'ethereum',mint_time:new Date('2026-09-15T12:00:00Z'),
  status:'scheduled',created_at:new Date('2026-09-14T12:00:00Z'),next_attempt_at:new Date('2026-09-15T12:00:00Z'),
  attempt_count:0,max_attempts:3,transaction_intent_id:null,idempotency_key:'scheduled-mint:test',
  via_opensea:false,stage_type:'public_sale',stage_uuid:'public-1',stage_label:'Public',
  reservation_stage_key:'uuid:public-1',eligibility_mode:'specific_stage',eligibility_deadline:null,
  allowance_scope:'unknown',allowance_max_per_wallet:null,allowance_minted_snapshot:null,
  allowance_source:null,allowance_verified_at:null,
  allowance_stage_start_at:new Date('2026-09-15T12:00:00Z'),
  phase_wait_count:0,...overrides,
});

function fixture(conflictRow=null){
  const calls=[];
  const client={async query(sql,params){calls.push({sql,params});
    if(sql.includes('SELECT task.* FROM mint_tasks'))return conflictRow
      ?{rowCount:1,rows:[conflictRow]}:{rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO mint_tasks'))return {rowCount:1,rows:[row()]};
    return {rowCount:1,rows:[]};},release(){calls.push({sql:'RELEASE'});}};
  return {calls,storage:createPostgresStorage({connect:async()=>client})};
}

function taskInput(overrides={}){const value=row(overrides);return {
  userId:value.user_id,id:value.id,name:value.name,walletLabel:value.wallet_label,
  walletAddress:value.wallet_address,contract:value.contract_address,fn:'mint',qty:value.quantity,price:0,gas:null,
  chain:value.chain,mintTime:value.mint_time.getTime(),status:'scheduled',createdAt:value.created_at.getTime(),
  nextAttemptAt:value.next_attempt_at.getTime(),maxAttempts:3,idempotencyKey:value.idempotency_key,
  viaOpenSea:false,stageType:value.stage_type,stageUuid:value.stage_uuid,stageLabel:value.stage_label,
  reservationStageKey:value.reservation_stage_key,eligibilityMode:'specific_stage',eligibilityDeadline:null,
  allowanceScope:value.allowance_scope,allowanceMaxPerWallet:value.allowance_max_per_wallet,
  allowanceMintedSnapshot:value.allowance_minted_snapshot,allowanceSource:value.allowance_source,
  allowanceVerifiedAt:value.allowance_verified_at?.getTime?.()??null,
  allowanceStageStartAt:value.allowance_stage_start_at?.getTime?.()??value.mint_time.getTime(),
};}

test('createReservedTask locks the wallet envelope and includes paused tasks in duplicate detection',async()=>{
  const {calls,storage}=fixture(row({status:'paused'}));
  const result=await storage.createReservedTask(taskInput());
  assert.equal(result.created,false);
  assert.equal(result.conflict.status,'paused');
  assert.equal(calls[0].sql,'BEGIN');
  assert.match(calls[1].sql,/pg_advisory_xact_lock/);
  const lookup=calls.find(call=>call.sql.includes('SELECT task.* FROM mint_tasks'));
  assert.match(lookup.sql,/status IN \('scheduled','claimed','retry','paused'\)/);
  assert.doesNotMatch(lookup.sql,/reservation_stage_key=\$5/,
    'the lock query must load the whole envelope so cross-stage cumulative caps can be checked');
  assert.deepEqual(lookup.params,[taskInput().userId,taskInput().walletAddress,
    taskInput().chain,taskInput().contract]);
  assert.equal(calls.some(call=>call.sql.includes('INSERT INTO mint_tasks')),false);
  assert.equal(calls.at(-2).sql,'COMMIT');
  assert.equal(calls.at(-1).sql,'RELEASE');
});

test('createReservedTask performs an insert-only write after the locked duplicate check',async()=>{
  const {calls,storage}=fixture();
  const result=await storage.createReservedTask(taskInput());
  assert.equal(result.created,true);
  const insert=calls.find(call=>call.sql.includes('INSERT INTO mint_tasks'));
  assert.ok(insert);
  assert.doesNotMatch(insert.sql,/ON CONFLICT/,
    'a caller-controlled task ID must never update an existing schedule during creation');
  assert.match(insert.sql,/wallet_address,reservation_stage_key/);
  assert.deepEqual(insert.params.slice(22,24),[taskInput().walletAddress,'uuid:public-1']);
});

test('createReservedTask enforces a later cumulative boundary before inserting an earlier stage',async()=>{
  const publicBoundary=row({id:'33333333-3333-4333-8333-333333333333',quantity:7,
    stage_uuid:'public-2',reservation_stage_key:'uuid:public-2',
    allowance_scope:'contract_cumulative',allowance_max_per_wallet:'10',
    allowance_minted_snapshot:'2'});
  const {calls,storage}=fixture(publicBoundary);
  await assert.rejects(storage.createReservedTask(taskInput({quantity:2,stage_uuid:'allow-1',
    stage_label:'Allowlist',stage_type:'allowlist',reservation_stage_key:'uuid:allow-1',
    allowance_minted_snapshot:'2',allowance_stage_start_at:new Date('2026-09-15T10:00:00Z')})),
  error=>error.code==='SCHEDULE_ALLOWANCE_EXCEEDED'&&error.details.remaining==='1');
  assert.equal(calls.some(call=>call.sql.includes('INSERT INTO mint_tasks')),false);
  assert.equal(calls.at(-2).sql,'ROLLBACK');
});
