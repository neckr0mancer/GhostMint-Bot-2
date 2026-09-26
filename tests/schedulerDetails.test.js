const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
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
    phase_wait_count:0,change_version:0,change_state:'clear',pending_change:null,
  };
}

test('schedule detail query is user scoped and returns ordered durable attempt/transaction evidence', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM mint_tasks'))return {rowCount:1,rows:[taskRow()]};
    if(sql.includes('FROM mint_task_change_events'))return {rowCount:0,rows:[]};
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
  assert.deepEqual(calls.map(call=>call.params),[[USER,TASK],[USER,TASK],[USER,TASK]]);
  assert.match(calls[1].sql,/attempt\.user_id=\$1 AND attempt\.task_id=\$2/);
  assert.match(calls[1].sql,/ORDER BY attempt\.attempt_number DESC/);
  assert.match(calls[2].sql,/WHERE user_id=\$1 AND task_id=\$2/);
});

test('another user receives no schedule detail or attempt history', async () => {
  let calls=0;
  const pool={query:async()=>{calls+=1;return {rowCount:0,rows:[]};}};
  const detail=await createSchedulerRepository(pool).detailsForUser(
    '33333333-3333-4333-8333-333333333333',TASK);
  assert.equal(detail,null);
  assert.equal(calls,1,'attempts must not be queried after the owned task lookup fails');
});

test('schedule-change websocket events are state-refreshing, versioned, and deduplicable',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const finalStart=source.indexOf('async function enforceScheduledChangePolicy');
  const finalEnd=source.indexOf('\nasync function',finalStart+20);
  const finalBranch=source.slice(finalStart,finalEnd);
  assert.match(finalBranch,/type:'task\.change-accepted'/);
  assert.match(finalBranch,/type:'tasks\.changed'/);
  assert.match(finalBranch,/notificationKey:`schedule:\$\{task\.id\}:change:\$\{task\.changeVersion\}:accepted`/);

  const runtimeStart=source.indexOf('if\(event\.scheduleChange\)');
  const runtimeEnd=source.indexOf("if \(event.outcome === 'starting'\)",runtimeStart);
  const runtimeBranch=source.slice(runtimeStart,runtimeEnd);
  assert.match(runtimeBranch,/type:'task\.change-review'/);
  assert.match(runtimeBranch,/type:'task\.rescheduled'/);
  assert.match(runtimeBranch,/type:'task\.failed'/);
  assert.match(runtimeBranch,/notificationKey:`schedule:\$\{event\.task\.id\}:change:\$\{event\.task\.changeVersion\}:review`/);
  assert.match(runtimeBranch,/notificationKey:`schedule:\$\{event\.task\.id\}:change:\$\{event\.task\.changeVersion\}:rescheduled`/);
});

test('an earliest-eligible stage advance reaches the atomic phase deferral before change-policy handling',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf("if (phaseAwareTask(task) && ['WALLET_NOT_ELIGIBLE','STAGE_NOT_OPEN'].includes(error?.code))");
  const end=source.indexOf('\n        throw error;',start);
  assert.ok(start>=0&&end>start,'the OpenSea phase-advance branch must remain identifiable');
  const branch=source.slice(start,end);
  assert.match(branch,/enforcePhaseDecision\(decision\)/,
    'the decision must become SCHEDULE_PHASE_WAIT so deferForPhase owns the durable stage move');
  assert.doesNotMatch(branch,/enforceScheduledChangePolicy/,
    'time/price handling before deferForPhase can return early and strand the old stage reservation');
  assert.match(source,/error\.phaseDeferral[\s\S]{0,260}stageUuid:nextStage\.uuid/,
    'the phase-wait payload must carry the new durable stage identity');
});

test('natural OpenSea phase advances move the reservation before schedule-change policy runs',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf('async function refreshScheduledOpenSeaPhase');
  const end=source.indexOf('\nasync function refreshScheduledPublicPhase',start);
  assert.ok(start>=0&&end>start,'the shared OpenSea phase refresh must remain identifiable');
  const branch=source.slice(start,end);
  const persisted=branch.indexOf('const persistedStageIdentity=scheduleStagePersistenceKey');
  const defer=branch.indexOf("throw phaseWaitError({...decision,status:'wait'");
  const policy=branch.indexOf('await enforceScheduledChangePolicy');
  assert.ok(persisted>=0&&defer>persisted&&policy>defer,
    'a later natural stage must become SCHEDULE_PHASE_WAIT before policy can pause or reschedule it');
  assert.match(branch,/uuid:task\.stageUuid,[\s\S]{0,100}label:task\.stageLabel,[\s\S]{0,100}stageType:task\.stageType/,
    'the persisted identity must use task field names rather than stage field names');
  assert.match(branch,/nextStage:observedStage/,
    'the phase wait must carry the concrete replacement stage to the atomic repository path');
});

test('advisory preflights do not create an approval loop when a stage match is missing or ambiguous',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf('const evaluateScheduledPreflight=createScheduledPreflightEvaluator');
  const end=source.indexOf('\n  resolveMintValueWei:',start);
  assert.ok(start>=0&&end>start,'the early preflight inspector must remain identifiable');
  const branch=source.slice(start,end);
  assert.doesNotMatch(branch,/stageMissing\s*:\s*true/,
    'an approval cannot resolve a missing stage when it has no concrete replacement identity');
  assert.match(branch,/if\(matches\.length!==1\)[\s\S]{0,700}throw new Error/,
    'the advisory probe should persist check_failed and leave final phase resolution authoritative');
});

test('validated OpenSea calls promote their provisional baseline only after decoded validation',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf('if (built) {');
  const end=source.indexOf("source:'opensea-built-call'",start);
  assert.ok(start>=0&&end>start,'the scheduled OpenSea built-call branch must remain identifiable');
  const branch=source.slice(start,end+300);
  const validate=branch.indexOf('validateOpenSeaMintCall');
  const policy=branch.indexOf('enforceScheduledChangePolicy');
  assert.ok(validate>=0&&policy>validate,
    'promotion must happen only after the exact OpenSea target/method/arguments pass validation');
  assert.match(branch,/validatedConfigurationPromotion:OPENSEA_VALIDATED_BUILDER_V1/);
});

test('plain scheduled calls pass their actual prepared configuration through the final policy gate',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf('const prepared = await prepareMintCall');
  const end=source.indexOf('\n    try {',start);
  assert.ok(start>=0&&end>start,'the final plain prepared-call branch must remain identifiable');
  const branch=source.slice(start,end);
  assert.match(branch,/if\(!scheduledSeaDrop\?\.address\)/);
  assert.match(branch,/decodedMintConfiguration\(prepared\.preview/);
  assert.match(branch,/source:'prepared-contract-call'/);
  assert.match(branch,/enforceScheduledChangePolicy/);
});

test('GLRTCH advisory checks use the same exact supported configuration as execution',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
  const start=source.indexOf('const evaluateScheduledPreflight=createScheduledPreflightEvaluator');
  const end=source.indexOf('\n  resolveMintValueWei:',start);
  assert.ok(start>=0&&end>start,'the early preflight inspector must remain identifiable');
  const branch=source.slice(start,end);
  assert.match(branch,/whitelistMint\(uint256,uint256,uint256,bytes32\[\]\)/);
  assert.match(branch,/publicMint\(uint256\)/);
  assert.match(branch,/standard:isGlrtchlist\?'GLRTCH allowlist':'GLRTCH public'/);
  assert.match(branch,/scheduleObservation=\{\.\.\.\(scheduleObservation\|\|\{\}\)/,
    'a phase-aware GLRTCH check must retain its opening observation while adding exact call terms');
});
