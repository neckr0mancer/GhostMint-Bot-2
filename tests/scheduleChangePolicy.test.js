'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { OPENSEA_VALIDATED_BUILDER_V1,configurationFingerprint,configurationSummary,
  evaluateScheduleObservation,openSeaValidatedBuilderBaseline }=require('../src/scheduler/scheduleChangePolicy');
const { CANONICAL_SEADROP_CORE_ADDRESS }=require('../src/mint/seaDropRegistry');
const { SEADROP_GATED_INTERFACE }=require('../src/mint/seaDropCall');

const HOUR=60*60*1000;
const base={id:'task-1',mintTime:1_800_000_000_000,originalOpeningAt:1_800_000_000_000,
  acceptedOpeningAt:1_800_000_000_000,acceptedPriceWeiPerItem:'100',
  acceptedConfigFingerprint:'config-a',eligibilityDeadline:1_800_000_000_000+24*HOUR,
  timeChangePolicy:'approval',maxOpeningDelayMs:null,priceChangePolicy:'approval',
  maxPriceWeiPerItem:null};

test('a simultaneous postponed opening and price increase becomes one bounded auto decision',()=>{
  const decision=evaluateScheduleObservation({...base,timeChangePolicy:'auto_within_limit',
    maxOpeningDelayMs:2*HOUR,priceChangePolicy:'allow_up_to_cap',maxPriceWeiPerItem:'150'},
  {openingAt:base.acceptedOpeningAt+HOUR,priceWeiPerItem:'125',configFingerprint:'config-a'},
  {now:base.acceptedOpeningAt-HOUR});
  assert.equal(decision.action,'auto_rescheduled');
  assert.deepEqual(decision.kinds,['opening','price']);
  assert.equal(decision.changes.length,2);
});

test('a paired start and closing-time postponement stays under the opening policy and remains auditable',()=>{
  const oldSummary=configurationSummary({chain:'ethereum',contract:'0xabc',callTarget:'0xdef',
    method:'mintPublic',stageIdentity:'uuid:one',endTime:1_800_000_900});
  const newSummary=configurationSummary({chain:'ethereum',contract:'0xabc',callTarget:'0xdef',
    method:'mintPublic',stageIdentity:'uuid:one',endTime:1_800_004_500});
  const decision=evaluateScheduleObservation({...base,timeChangePolicy:'auto_within_limit',
    maxOpeningDelayMs:2*HOUR,acceptedConfigFingerprint:configurationFingerprint(oldSummary),
    acceptedConfigSummary:oldSummary},{openingAt:base.acceptedOpeningAt+HOUR,
    priceWeiPerItem:'100',configFingerprint:configurationFingerprint(newSummary),
    configSummary:newSummary},{now:base.mintTime-1_000});
  assert.equal(decision.action,'auto_rescheduled');
  assert.deepEqual(decision.kinds,['opening','closing']);
  assert.doesNotMatch(decision.reason,/configuration/i);
  assert.equal(decision.observed.configSummary.endTime,'1800004500');
});

test('a closing-only shift is accepted and recorded without authorizing a call change',()=>{
  const oldSummary=configurationSummary({chain:'ethereum',contract:'0xabc',callTarget:'0xdef',
    method:'mintPublic',stageIdentity:'uuid:one',endTime:1_800_000_900});
  const newSummary={...oldSummary,endTime:'1800004500'};
  const decision=evaluateScheduleObservation({...base,
    acceptedConfigFingerprint:configurationFingerprint(oldSummary),acceptedConfigSummary:oldSummary},
  {openingAt:base.acceptedOpeningAt,priceWeiPerItem:'100',
    configFingerprint:configurationFingerprint(newSummary),configSummary:newSummary});
  assert.equal(decision.action,'accepted');
  assert.deepEqual(decision.kinds,['closing']);
  assert.match(decision.reason,/closing time changed/i);
});

test('delay allowance is measured from the original opening so small repeated slips cannot leapfrog the cap',()=>{
  const decision=evaluateScheduleObservation({...base,acceptedOpeningAt:base.originalOpeningAt+HOUR,
    timeChangePolicy:'auto_within_limit',maxOpeningDelayMs:2*HOUR},
  {openingAt:base.originalOpeningAt+3*HOUR,priceWeiPerItem:'100',configFingerprint:'config-a'});
  assert.equal(decision.action,'awaiting_approval');
  assert.match(decision.reason,/later than the delay limit/i);
});

test('an earlier opening never authorizes an earlier spend automatically',()=>{
  const decision=evaluateScheduleObservation({...base,timeChangePolicy:'auto_within_limit',maxOpeningDelayMs:2*HOUR},
  {openingAt:base.acceptedOpeningAt-HOUR,priceWeiPerItem:'100',configFingerprint:'config-a'});
  assert.equal(decision.action,'awaiting_approval');
  assert.match(decision.reason,/earlier/i);
});

test('an opted-in exact stage follows earlier and multi-day later openings',()=>{
  const later=evaluateScheduleObservation({...base,timeChangePolicy:'auto_follow_stage',
    maxOpeningDelayMs:null},{openingAt:base.acceptedOpeningAt+72*HOUR,
    priceWeiPerItem:'100',configFingerprint:'config-a'},{now:base.acceptedOpeningAt-HOUR});
  assert.equal(later.action,'auto_rescheduled');
  assert.equal(later.nextEligibilityDeadline,base.eligibilityDeadline+72*HOUR);

  const earlier=evaluateScheduleObservation({...base,timeChangePolicy:'auto_follow_stage',
    maxOpeningDelayMs:null},{openingAt:base.acceptedOpeningAt-6*HOUR,
    priceWeiPerItem:'100',configFingerprint:'config-a'},{now:base.acceptedOpeningAt-12*HOUR});
  assert.equal(earlier.action,'auto_rescheduled');
  assert.equal(earlier.nextEligibilityDeadline,base.eligibilityDeadline-6*HOUR);
});

test('exact time following never overrides a price cap, stage removal, or call change',()=>{
  const exact={...base,timeChangePolicy:'auto_follow_stage',priceChangePolicy:'allow_up_to_cap',
    maxPriceWeiPerItem:'110'};
  assert.equal(evaluateScheduleObservation(exact,{openingAt:base.acceptedOpeningAt+72*HOUR,
    priceWeiPerItem:'125',configFingerprint:'config-a'}).action,'awaiting_approval');
  assert.equal(evaluateScheduleObservation(exact,{stageMissing:true}).action,'awaiting_approval');
  assert.equal(evaluateScheduleObservation(exact,{openingAt:base.acceptedOpeningAt+72*HOUR,
    priceWeiPerItem:'100',configFingerprint:'config-b',configSummary:{method:'mintSigned'}}).action,
  'awaiting_approval');
});

test('a later stage opening still cannot pull execution before the user-approved mint time',()=>{
  const now=base.acceptedOpeningAt;
  const approvedAttempt=now+30*60_000;
  const task={...base,mintTime:approvedAttempt,timeChangePolicy:'auto_within_limit',
    maxOpeningDelayMs:60*60_000};
  const decision=evaluateScheduleObservation(task,{openingAt:now+5*60_000,
    priceWeiPerItem:'100',configFingerprint:'config-a'},{now});
  assert.equal(decision.action,'accepted');
  assert.equal(decision.observed.openingAt,now+5*60_000);
});

test('price drops are accepted but an increase without a cap requires review',()=>{
  assert.equal(evaluateScheduleObservation(base,{openingAt:base.acceptedOpeningAt,
    priceWeiPerItem:'90',configFingerprint:'config-a'}).action,'accepted');
  const higher=evaluateScheduleObservation(base,{openingAt:base.acceptedOpeningAt,
    priceWeiPerItem:'101',configFingerprint:'config-a'});
  assert.equal(higher.action,'awaiting_approval');
  assert.match(higher.reason,/price increased/i);
});

test('a newly discovered paid price for a legacy unknown baseline fails closed',()=>{
  const decision=evaluateScheduleObservation({...base,acceptedPriceWeiPerItem:null},
    {openingAt:base.acceptedOpeningAt,priceWeiPerItem:'1',configFingerprint:'config-a'});
  assert.equal(decision.action,'awaiting_approval');
  assert.match(decision.reason,/verified price/i);
});

test('call target or method changes always require review',()=>{
  const fromSummary=configurationSummary({chain:'ethereum',contract:'0xabc',callTarget:'0x111',
    method:'mintPublic',standard:'SeaDrop',feeRecipient:'0x222'});
  const toSummary=configurationSummary({chain:'ethereum',contract:'0xabc',callTarget:'0x333',
    method:'mintSigned',standard:'SeaDrop signed mint',feeRecipient:'0x444',
    authorization:'signature: signature present'});
  const decision=evaluateScheduleObservation({...base,acceptedConfigSummary:fromSummary},
    {openingAt:base.acceptedOpeningAt,priceWeiPerItem:'100',configFingerprint:'config-b',
      configSummary:toSummary});
  assert.equal(decision.action,'awaiting_approval');
  assert.deepEqual(decision.kinds,['configuration']);
  assert.deepEqual(decision.changes[0].fromSummary,fromSummary);
  assert.deepEqual(decision.changes[0].toSummary,toSummary);
  assert.doesNotMatch(JSON.stringify(decision),/0x[0-9a-f]{128}/i);
});

test('a definitively missing saved stage requires review rather than silently choosing another',()=>{
  const decision=evaluateScheduleObservation(base,{stageMissing:true,source:'early-opensea-stage'});
  assert.equal(decision.action,'awaiting_approval');
  assert.deepEqual(decision.kinds,['stage_removed']);
  assert.match(decision.reason,/no longer present/i);
});

test('a delayed opening outside the task deadline expires instead of waiting forever',()=>{
  const decision=evaluateScheduleObservation({...base,timeChangePolicy:'auto_within_limit',
    maxOpeningDelayMs:24*HOUR},{openingAt:base.eligibilityDeadline,
    priceWeiPerItem:'100',configFingerprint:'config-a'});
  assert.equal(decision.action,'expired');
  assert.match(decision.reason,/outside.*safety window/i);
});

test('configuration fingerprints are stable across key order and exclude price/time policy',()=>{
  const left=configurationFingerprint({chain:'ethereum',contract:'0xabc',callTarget:'0xdef',
    method:'0x12345678',feeRecipient:'0xaaa',stageIdentity:'uuid:one',price:'1'});
  const right=configurationFingerprint({stageIdentity:'uuid:one',feeRecipient:'0xaaa',
    method:'0x12345678',callTarget:'0xdef',contract:'0xabc',chain:'ethereum',price:'9'});
  assert.equal(left,right);
  assert.notEqual(left,configurationFingerprint({stageIdentity:'uuid:one',feeRecipient:'0xaaa',
    method:'0x12345678',callTarget:'0xdef',contract:'0xabc',chain:'ethereum',
    maxPerWallet:2,feeBps:250,restrictFeeRecipients:true,endTime:1_900_000_000}));
  assert.notEqual(left,configurationFingerprint({stageIdentity:'uuid:one',feeRecipient:'0xaaa',
    method:'0X12345678',callTarget:'0xdef',contract:'0xabc',chain:'ethereum'}));
});

test('configuration summaries retain review facts but never accept raw proof or signature fields',()=>{
  const summary=configurationSummary({chain:'Ethereum',contract:'0xABC',callTarget:'0xDEF',
    method:'mintAllowList',authorization:'proof: proof present (3 items)',
    proof:`0x${'ab'.repeat(32)}`,signature:`0x${'cd'.repeat(65)}`});
  assert.equal(summary.chain,'ethereum');
  assert.equal(summary.method,'mintAllowList');
  assert.equal(summary.authorization,'proof: proof present (3 items)');
  assert.equal(Object.hasOwn(summary,'proof'),false);
  assert.equal(Object.hasOwn(summary,'signature'),false);
});

test('an unknown runtime configuration fails closed but creation can establish the reviewed baseline',()=>{
  const observation={openingAt:base.acceptedOpeningAt,priceWeiPerItem:'100',
    configSummary:configurationSummary({chain:'ethereum',contract:'0xabc',
      callTarget:'0xdef',method:'mintPublic'})};
  const legacy={...base,acceptedConfigFingerprint:null,acceptedConfigSummary:null};
  const runtime=evaluateScheduleObservation(legacy,observation);
  assert.equal(runtime.action,'awaiting_approval');
  assert.match(runtime.reason,/verified transaction configuration/i);
  const creation=evaluateScheduleObservation(legacy,observation,{allowConfigurationBaseline:true});
  assert.equal(creation.action,'accepted');
});

test('a validated OpenSea builder sentinel promotes once to an exact safe call',()=>{
  const sentinel=openSeaValidatedBuilderBaseline({chain:'ethereum',contract:'0xabc',
    stageIdentity:'uuid:allow-1'});
  assert.equal(sentinel.authorization,OPENSEA_VALIDATED_BUILDER_V1);
  const task={...base,acceptedConfigSummary:sentinel,
    acceptedConfigFingerprint:configurationFingerprint(sentinel)};
  const exact=configurationSummary({chain:'ethereum',contract:'0xabc',
    callTarget:CANONICAL_SEADROP_CORE_ADDRESS,
    method:SEADROP_GATED_INTERFACE.getFunction('mintSigned').format('sighash'),
    standard:'SeaDrop signed mint',stageIdentity:'uuid:allow-1',
    configurationDigest:'a'.repeat(64),
    authorization:'signature: signature present'});
  const observation={openingAt:base.acceptedOpeningAt,priceWeiPerItem:'100',
    configFingerprint:configurationFingerprint(exact),configSummary:exact};

  assert.equal(evaluateScheduleObservation(task,observation).action,'awaiting_approval',
    'merely having a sentinel never suppresses review');
  const promoted=evaluateScheduleObservation(task,observation,
    {validatedConfigurationPromotion:OPENSEA_VALIDATED_BUILDER_V1});
  assert.equal(promoted.action,'accepted');
  assert.deepEqual(promoted.kinds,['configuration']);
  assert.deepEqual(promoted.observed.configSummary,exact);
});

test('OpenSea promotion rejects a different stage or a non-canonical target',()=>{
  const sentinel=openSeaValidatedBuilderBaseline({chain:'ethereum',contract:'0xabc',
    stageIdentity:'uuid:allow-1'});
  const task={...base,acceptedConfigSummary:sentinel,
    acceptedConfigFingerprint:configurationFingerprint(sentinel)};
  const candidate=overrides=>{
    const summary=configurationSummary({chain:'ethereum',contract:'0xabc',
      callTarget:CANONICAL_SEADROP_CORE_ADDRESS,
      method:SEADROP_GATED_INTERFACE.getFunction('mintAllowList').format('sighash'),
      standard:'SeaDrop allowlist',stageIdentity:'uuid:allow-1',
      configurationDigest:'b'.repeat(64),
      authorization:'proof: proof present (2 items)',...overrides});
    return evaluateScheduleObservation(task,{openingAt:base.acceptedOpeningAt,
      priceWeiPerItem:'100',configFingerprint:configurationFingerprint(summary),configSummary:summary},
    {validatedConfigurationPromotion:OPENSEA_VALIDATED_BUILDER_V1});
  };
  assert.equal(candidate({stageIdentity:'uuid:public-2'}).action,'awaiting_approval');
  assert.equal(candidate({callTarget:'0x0000000000000000000000000000000000000123'}).action,
    'awaiting_approval');
  assert.equal(candidate({method:'drain(address)'}).action,'awaiting_approval');
  assert.equal(candidate({configurationDigest:null}).action,'awaiting_approval');
});
