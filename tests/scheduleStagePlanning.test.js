'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScheduleStagePlan, decorateScheduleDrop, scheduleStageFacts, scheduleStageKey,
  scheduleReservationStageKey, scheduleReservationStagesConflict, stageRequiresEligibilityCheck,
  resolveRecommendedScheduleStage } = require('../src/mint/scheduleStagePlanning');

const NOW = 1_800_000_000_000;
const stage = (uuid, startTime, overrides = {}) => ({
  uuid, label: uuid, startTime, endTime:startTime + 3600,
  stageType:'public_sale', maxPerWallet:10, ...overrides,
});

test('the automatic schedule skips an unknown gated stage and recommends the earliest confirmed-safe stage',()=>{
  const allowlist=stage('allowlist',1_800_000_100,{stageType:'signed_presale'});
  const publicStage=stage('public',1_800_003_700);
  const plan=buildScheduleStagePlan({stages:[publicStage,allowlist]},{now:NOW});
  assert.deepEqual(plan,{
    recommendedStageKey:'uuid:public',recommendedStageUuid:'public',
    recommendedStageLabel:'public',recommendedStageType:'public_sale',
    eligibilityMode:'specific_stage',eligibilityState:'open_to_all',
    eligibilityLabel:'Open to all wallets',advancesIfIneligible:false,
  });
  assert.equal(buildScheduleStagePlan({stages:[allowlist]},{now:NOW}),null,
    'an unknown allowlist remains a manual choice rather than an automatic eligibility claim');
});

test('a complete four-stage catalog stays visible while PUBLIC is the safe automatic choice',()=>{
  const stages=[
    stage('hundred',1_800_000_100,{label:'HUNDRED',stageType:'presale',maxPerWallet:100}),
    stage('team',1_800_000_200,{label:'TEAM',stageType:'presale',maxPerWallet:5}),
    stage('wl',1_800_000_300,{label:'WL',stageType:'presale',maxPerWallet:1}),
    stage('public',1_800_000_400,{label:'PUBLIC',stageType:'public_sale',maxPerWallet:1}),
  ];
  const decorated=decorateScheduleDrop({stages});

  assert.deepEqual(decorated.stages.map(item=>item.label),['HUNDRED','TEAM','WL','PUBLIC']);
  assert.deepEqual(decorated.stages.slice(0,3).map(item=>item.eligibilityState),
    ['check_at_open','check_at_open','check_at_open']);
  assert.equal(decorated.stages[3].eligibilityState,'open_to_all');
  assert.equal(buildScheduleStagePlan(decorated,{now:NOW}).recommendedStageLabel,'PUBLIC');
});

test('explicit wallet eligibility evidence survives decoration and governs automatic recommendations',()=>{
  const eligible=stage('eligible',1_800_000_100,{stageType:'signed_presale',eligibilityState:'eligible'});
  const ineligible=stage('ineligible',1_800_000_050,{stageType:'allowlist',eligibility_state:'ineligible'});
  const publicStage=stage('public',1_800_003_700);
  const decorated=decorateScheduleDrop({stages:[publicStage,ineligible,eligible]});

  assert.equal(decorated.stages.find(item=>item.uuid==='eligible').eligibilityState,'eligible');
  assert.equal(decorated.stages.find(item=>item.uuid==='eligible').eligibilityLabel,'Eligible for this wallet');
  assert.equal(decorated.stages.find(item=>item.uuid==='ineligible').eligibilityState,'ineligible');
  assert.equal(decorated.stages.find(item=>item.uuid==='ineligible').eligibilityLabel,'Not eligible for this wallet');
  assert.equal(buildScheduleStagePlan(decorated,{now:NOW}).recommendedStageUuid,'eligible',
    'the earliest explicit eligible stage wins over a later public stage');

  const withoutEligible=decorateScheduleDrop({stages:[ineligible,publicStage]});
  assert.equal(buildScheduleStagePlan(withoutEligible,{now:NOW}).recommendedStageUuid,'public',
    'an explicitly ineligible stage is never recommended');
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

test('a malformed stage that ends before its future start is never recommended',()=>{
  const malformed=stage('malformed',1_800_003_700,{endTime:1_800_001_800});
  assert.equal(buildScheduleStagePlan({stages:[malformed]},{now:NOW}),null);
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

test('UUID-less direct public reservations alias matching newly indexed metadata without collapsing distinct stages',()=>{
  const fallback=scheduleReservationStageKey({stageUuid:null,stageLabel:'Public sale',
    stageType:'seadrop_public_drop',mintTime:1_800_000_100_000,directPublic:true});
  const indexed=scheduleReservationStageKey({stageUuid:'provider-public-uuid',stageLabel:'PUBLIC',
    stageType:'public_sale',mintTime:1_800_000_100_000,directPublic:true});
  assert.equal(fallback,'phase:direct_public');
  assert.equal(indexed,'uuid:provider-public-uuid',
    'a real provider phase keeps its identity so distinct public phases remain independently schedulable');
  assert.equal(scheduleReservationStagesConflict({stageUuid:null,stageLabel:'Public sale',
    stageType:'seadrop_public_drop',stageStartAt:1_800_000_100_000,directPublic:true},{
    stageUuid:'provider-public-uuid',stageLabel:'PUBLIC',stageType:'public_sale',
    stageStartAt:1_800_000_100_000,directPublic:false}),true,
  'metadata appearing for the same opening must not permit a duplicate schedule');
  assert.equal(scheduleReservationStagesConflict({stageUuid:'public-one',stageLabel:'PUBLIC',
    stageType:'public_sale',stageStartAt:1_800_000_100_000,directPublic:true},{
    stageUuid:'public-two',stageLabel:'PUBLIC',stageType:'public_sale',
    stageStartAt:1_800_003_700_000,directPublic:true}),false,
  'two genuinely distinct indexed public phases must not be collapsed');
  assert.equal(scheduleReservationStageKey({stageUuid:'provider-public-uuid',stageLabel:'PUBLIC',
    stageType:'public_sale',mintTime:1_800_000_100_000,directPublic:false}),
  'uuid:provider-public-uuid','builder-backed provider phases keep their exact UUID identity');
  assert.equal(scheduleReservationStageKey({stageUuid:null,stageLabel:'Provider public',
    stageType:'public_sale',mintTime:1_800_000_100_000,directPublic:true}),
  'phase:public_sale:provider public',
  'a UUID-less provider phase never inherits the synthesized PublicDrop identity');
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
  assert.equal(scheduleStageFacts(allow,{stages:[allow]}).advancesIfIneligible,false);
  const tooLate=stage('late-public',1_800_086_501);
  assert.equal(scheduleStageFacts(allow,{stages:[allow,tooLate]}).advancesIfIneligible,false);
  const explicitlyIneligible=stage('later-ineligible',1_800_000_200,
    {stageType:'signed_presale',eligibilityState:'ineligible'});
  const malformed=stage('later-malformed',1_800_000_300,{endTime:1_800_000_250});
  const duplicateOne={label:'Public sale',stageType:'public_sale',startTime:1_800_000_400,endTime:1_800_000_500};
  const duplicateTwo={...duplicateOne,startTime:1_800_000_600,endTime:1_800_000_700};
  assert.equal(scheduleStageFacts(allow,{stages:[allow,explicitlyIneligible]}).advancesIfIneligible,false);
  assert.equal(scheduleStageFacts(allow,{stages:[allow,malformed]}).advancesIfIneligible,false);
  assert.equal(scheduleStageFacts(allow,{stages:[allow,duplicateOne,duplicateTwo]}).advancesIfIneligible,false,
    'an ambiguous later phase cannot support a safe advancement promise');
  const safePublic=stage('later-public',1_800_000_800);
  assert.equal(scheduleStageFacts(allow,{stages:[allow,safePublic]}).advancesIfIneligible,true);
});

test('repeated UUID-less phase identities are marked ambiguous and never auto-selected',()=>{
  const first={label:'Allowlist',stageType:'allowlist',startTime:1_800_000_100,endTime:1_800_000_200};
  const second={...first,startTime:1_800_000_300,endTime:1_800_000_400};
  const decorated=decorateScheduleDrop({stages:[first,second]});
  assert.equal(decorated.stages.every(item=>item.identityAmbiguous&&!item.schedulable),true);
  assert.equal(buildScheduleStagePlan(decorated,{now:NOW}),null);
});

test('a server-owned recommendation resolves by UUID even when provider stage order changes',()=>{
  const allow=stage('allow',1_800_000_100,{stageType:'allowlist',eligibilityState:'eligible'});
  const publicStage=stage('public',1_800_003_700);
  const plan=buildScheduleStagePlan({stages:[allow,publicStage]},{now:NOW});
  const resolved=resolveRecommendedScheduleStage({drop:{stages:[publicStage,allow]},schedulePlan:plan,now:NOW});
  assert.equal(resolved.uuid,'allow');
});

test('a provider without UUIDs resolves one exact stable key but never an ambiguous identity',()=>{
  const unique={label:'Public sale',stageType:'public_sale',startTime:1_800_000_100,endTime:1_800_000_200};
  const plan={recommendedStageUuid:null,recommendedStageKey:scheduleStageKey(unique)};
  assert.equal(resolveRecommendedScheduleStage({drop:{stages:[unique]},schedulePlan:plan,now:NOW}),unique);

  const first={label:'Allowlist',stageType:'allowlist',startTime:1_800_000_300,endTime:1_800_000_400};
  const second={...first,startTime:1_800_000_500,endTime:1_800_000_600};
  const ambiguousPlan={recommendedStageUuid:null,recommendedStageKey:scheduleStageKey(first)};
  assert.equal(resolveRecommendedScheduleStage({drop:{stages:[first,second]},schedulePlan:ambiguousPlan,now:NOW}),null);
});

test('a stale UUID recommendation is rejected instead of falling back to a guessed key',()=>{
  const publicStage=stage('public',1_800_000_100);
  const stale={recommendedStageUuid:'removed-stage',recommendedStageKey:scheduleStageKey(publicStage)};
  assert.equal(resolveRecommendedScheduleStage({drop:{stages:[publicStage]},schedulePlan:stale,now:NOW}),null);
});
