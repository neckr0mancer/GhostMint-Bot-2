const assert=require('node:assert/strict');
const test=require('node:test');
const {createTargetPolicyRepository}=require('../src/triggers/targetPolicyRepository');

test('trigger audit paging stays tenant scoped, searchable, stable, and camel-cased',async()=>{
  const calls=[];
  const pool={query:async(sql,params)=>{
    const compact=String(sql).replace(/\s+/g,' ').trim();
    calls.push({sql:compact,params});
    if(compact.includes('COUNT(*)'))return {rows:[{total:3}]};
    return {rows:[{audit_id:'41',user_id:'user-a',target_type:'sniper',
      target_id:'123e4567-e89b-42d3-a456-426614174000',trigger_source:'social-triggered',
      source_event_id:'event-1',verification_state:'bypassed',dont_ask_again_active:true,
      confirmation_shown:false,transaction_intent_id:null,transaction_hash:'0xabc',chain:'ethereum',
      outcome:'confirmed',executed_at:new Date('2026-01-02T03:04:05.000Z')} ]};
  }};
  const result=await createTargetPolicyRepository(pool).listAuditPage('user-a',{
    limit:5,offset:10,search:'0xabc',
  });
  assert.equal(result.total,3);
  assert.deepEqual(result.items,[{auditId:'41',userId:'user-a',targetType:'sniper',
    targetId:'123e4567-e89b-42d3-a456-426614174000',triggerSource:'social-triggered',
    sourceEventId:'event-1',verificationState:'bypassed',dontAskAgainActive:true,
    confirmationShown:false,transactionIntentId:null,transactionHash:'0xabc',chain:'ethereum',
    outcome:'confirmed',executedAt:'2026-01-02T03:04:05.000Z'}]);
  const rows=calls.find(call=>!call.sql.includes('COUNT(*)'));
  const count=calls.find(call=>call.sql.includes('COUNT(*)'));
  assert.deepEqual(rows.params,['user-a',5,10,'%0xabc%']);
  assert.deepEqual(count.params,['user-a','%0xabc%']);
  assert.match(rows.sql,/LEFT JOIN transaction_intents intent/);
  assert.match(rows.sql,/intent\.user_id=audit\.user_id/);
  assert.match(rows.sql,/WHERE audit\.user_id=\$1/);
  assert.match(count.sql,/WHERE audit\.user_id=\$1/);
  assert.match(rows.sql,/target_id::TEXT ILIKE \$4/);
  assert.match(rows.sql,/source_event_id ILIKE \$4/);
  assert.match(rows.sql,/transaction_hash/);
  assert.match(rows.sql,/ORDER BY audit\.executed_at DESC,audit\.audit_id DESC LIMIT \$2 OFFSET \$3/);
  assert.doesNotMatch(rows.sql,/0xabc/,'search text must stay in bound parameters');
  assert.doesNotMatch(count.sql,/0xabc/,'count search text must stay in bound parameters');
});
