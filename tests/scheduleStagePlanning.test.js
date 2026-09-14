'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScheduleStagePlan, decorateScheduleDrop, scheduleStageFacts, scheduleStageKey,
  stageRequiresEligibilityCheck } = require('../src/mint/scheduleStagePlanning');

const NOW = 1_800_000_000_000;
const stage = (uuid, startTime, overrides = {}) => ({
  uuid, label: uuid, startTime, endTime:startTime + 3600,
  stageType:'public_sale', maxPerWallet:10, ...overrides,
});

test('the automatic schedule starts at the earliest stage and defers gated eligibility until opening',()=>{
  const allowlist=stage('allowlist',1_800_000_100,{stageType:'signed_presale'});
  const publicStage=stage('public',1_800_003_700);
  const plan=buildScheduleStagePlan({stages:[publicStage,allowlist]},{now:NOW});
  assert.deepEqual(plan,{
    recommendedStageKey:'uuid:allowlist',recommendedStageUuid:'allowlist',
    recommendedStageLabel:'allowlist',recommendedStageType:'signed_presale',
    eligibilityMode:'earliest_eligible',eligibilityState:'check_at_open',
    eligibilityLabel:'Eligibility checked at opening',advancesIfIneligible:true,
  });
});

test('an upcoming public stage is marked open to all and does not claim a wallet proof check',()=>{
  const publicStage=stage('public',1_800_000_100);
  const plan=buildScheduleStagePlan({stages:[publicStage]},{now:NOW});
  assert.equal(plan.recommendedStageUuid,'public');
  assert.equal(plan.eligibilityMode,'specific_stage');
  assert.equal(plan.eligibilityState,'open_to_all');
  assert.equal(plan.advancesIfIneligible,false);
  assert.deepEqual(scheduleStageFacts(publicStage),{
    requiresEligibilityCheck:false,eligibilityMode:'specific_stage',eligibilityState:'open_to_all',
    eligibilityLabel:'Open to all wallets',advancesIfIneligible:false,
    identityAmbiguous:false,schedulable:true,
  });
});

test('ended and already-live stages are not presented as future automatic selections',()=>{
  const ended=stage('ended',1_799_990_000,{endTime:1_799_999_000});
  const live=stage('live',1_799_999_900,{endTime:1_800_000_500});
  assert.equal(buildScheduleStagePlan({stages:[ended,live]},{now:NOW}),null);
});

test('label-only public stages and deterministic fallback keys remain unambiguous',()=>{
  const publicStage={label:'Public sale',startTime:1_800_000_100,endTime:1_800_000_200};
  assert.equal(stageRequiresEligibilityCheck(publicStage),false);
  assert.equal(scheduleStageKey(publicStage),'stage::public sale:1800000100:1800000200');
});

test('public stage type spelling is normalized consistently with the worker',()=>{
  assert.equal(stageRequiresEligibilityCheck(stage('public-space',1_800_000_100,{stageType:'Public Sale'})),false);
  assert.equal(stageRequiresEligibilityCheck(stage('public-hyphen',1_800_000_200,{stageType:'public-sale'})),false);
});

test('a partial provider response can recommend a nextStage that is absent from stages',()=>{
  const active=stage('active',1_799_999_900,{endTime:1_800_000_050});
  const next=stage('next',1_800_000_100);
  const decorated=decorateScheduleDrop({stages:[active],activeStage:active,nextStage:next});
  assert.deepEqual(decorated.stages.map(item=>item.uuid),['active','next']);
  assert.equal(buildScheduleStagePlan(decorated,{now:NOW}).recommendedStageUuid,'next');
});

test('advancement is promised only when a later stage is reachable inside 24 hours',()=>{
  const allow=stage('allow',1_800_000_100,{stageType:'allowlist'});
  assert.equal(buildScheduleStagePlan({stages:[allow]},{now:NOW}).advancesIfIneligible,false);
  const tooLate=stage('late-public',1_800_086_501);
  assert.equal(buildScheduleStagePlan({stages:[allow,tooLate]},{now:NOW}).advancesIfIneligible,false);
});

test('repeated UUID-less phase identities are marked ambiguous and never auto-selected',()=>{
  const first={label:'Allowlist',stageType:'allowlist',startTime:1_800_000_100,endTime:1_800_000_200};
  const second={...first,startTime:1_800_000_300,endTime:1_800_000_400};
  const decorated=decorateScheduleDrop({stages:[first,second]});
  assert.equal(decorated.stages.every(item=>item.identityAmbiguous&&!item.schedulable),true);
  assert.equal(buildScheduleStagePlan(decorated,{now:NOW}),null);
});
