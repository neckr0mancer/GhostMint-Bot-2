const assert = require('node:assert/strict');
const test = require('node:test');
const { createSchedulerRepository } = require('../src/scheduler/schedulerRepository');

const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

function taskRow() {
  return {
    id:TASK,user_id:USER,name:'Public launch',wallet_label:'alpha',
    contract_address:'0x0000000000000000000000000000000000000001',function_name:'mint',
    quantity:1,price_eth:'0',gas_gwei:null,mint_time:new Date('2026-09-02T10:00:00Z'),
    status:'failed',created_at:new Date('2026-09-02T09:00:00Z'),next_attempt_at:new Date('2026-09-02T10:00:00Z'),
    attempt_count:1,max_attempts:3,claimed_by:null,claimed_at:null,lease_expires_at:null,
    transaction_intent_id:null,idempotency_key:`scheduled-mint:${USER}:${TASK}`,
    last_error:'The chain had not reached the public opening yet.',completed_at:new Date('2026-09-02T10:00:01Z'),
    via_opensea:false,stage_type:'public_sale',chain:'robinhood',stage_uuid:'stage-a',
    stage_label:'Public',eligibility_mode:'specific_stage',eligibility_deadline:new Date('2026-09-03T10:00:00Z'),
    phase_wait_count:0,
  };
}

test('schedule detail query is user scoped and returns ordered durable attempt/transaction evidence', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM mint_tasks'))return {rowCount:1,rows:[taskRow()]};
    return {rowCount:1,rows:[{
      attempt_id:'9',user_id:USER,task_id:TASK,attempt_number:1,outcome:'failure',
      reason:'The chain had not reached the public opening yet.',started_at:new Date('2026-09-02T10:00:00Z'),
      finished_at:new Date('2026-09-02T10:00:01Z'),transaction_intent_id:null,
    }]};
  }};
  const detail=await createSchedulerRepository(pool).detailsForUser(USER,TASK);
  assert.equal(detail.userId,USER);
  assert.equal(detail.attempts[0].attemptNumber,1);
  assert.match(detail.attempts[0].reason,/chain had not reached/i);
  assert.deepEqual(calls.map(call=>call.params),[[USER,TASK],[USER,TASK]]);
  assert.match(calls[1].sql,/attempt\.user_id=\$1 AND attempt\.task_id=\$2/);
  assert.match(calls[1].sql,/ORDER BY attempt\.attempt_number DESC/);
});

test('another user receives no schedule detail or attempt history', async () => {
  let calls=0;
  const pool={query:async()=>{calls+=1;return {rowCount:0,rows:[]};}};
  const detail=await createSchedulerRepository(pool).detailsForUser(
    '33333333-3333-4333-8333-333333333333',TASK);
  assert.equal(detail,null);
  assert.equal(calls,1,'attempts must not be queried after the owned task lookup fails');
});
