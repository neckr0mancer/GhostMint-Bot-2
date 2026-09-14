'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeaDropAllowanceEvidence, enforceScheduleAllowanceEnvelope,
  stageMatchesPublicDrop } = require('../src/mint/scheduleAllowance');

const base = (overrides = {}) => ({
  qty:1,mintTime:Date.parse('2026-09-20T12:00:15Z'),
  allowanceStageStartAt:Date.parse('2026-09-20T12:00:00Z'),
  allowanceScope:'unknown',allowanceMaxPerWallet:null,allowanceMintedSnapshot:'2',
  ...overrides,
});

test('only an exactly matched public SeaDrop window becomes a contract-cumulative boundary', () => {
  const stage={stageType:'public_sale',startTime:1_800_000_000,endTime:1_800_003_600};
  const publicDrop={startTime:1_800_000_000,endTime:1_800_003_600,maxTotalMintableByWallet:10};
  assert.equal(stageMatchesPublicDrop(stage,publicDrop),true);
  const evidence=buildSeaDropAllowanceEvidence({stage,publicDrop,
    mintStats:{minterNumMinted:'2'},verifiedAt:123});
  assert.deepEqual(evidence,{
    allowanceScope:'contract_cumulative',allowanceMaxPerWallet:'10',
    allowanceMintedSnapshot:'2',allowanceSource:'seadrop:PublicDrop+getMintStats',
    allowanceVerifiedAt:123,allowanceStageStartAt:1_800_000_000_000,
  });
});

test('gated or mismatched provider stages remain unknown and never create a guessed hard cap', () => {
  const publicDrop={startTime:1_800_000_000,endTime:1_800_003_600,maxTotalMintableByWallet:10};
  const gated=buildSeaDropAllowanceEvidence({
    stage:{stageType:'allowlist',startTime:1_799_999_000},publicDrop,
    mintStats:{minterNumMinted:'2'},verifiedAt:123,
  });
  assert.equal(gated.allowanceScope,'unknown');
  assert.equal(gated.allowanceMaxPerWallet,null);
  assert.equal(gated.allowanceMintedSnapshot,'2');
  const moved=buildSeaDropAllowanceEvidence({
    stage:{stageType:'public_sale',startTime:1_800_000_001},publicDrop,
    mintStats:{minterNumMinted:'2'},verifiedAt:123,
  });
  assert.equal(moved.allowanceScope,'unknown');
});

test('a phase-less direct SeaDrop schedule cannot evade the public cap by omitting stage metadata', () => {
  const publicDrop={startTime:1_800_000_000,endTime:1_800_003_600,maxTotalMintableByWallet:10};
  const evidence=buildSeaDropAllowanceEvidence({
    stage:{directPublic:true,mintTime:1_800_000_015,startTime:1_800_000_015},publicDrop,
    mintStats:{minterNumMinted:'4'},verifiedAt:123,
  });
  assert.equal(evidence.allowanceScope,'contract_cumulative');
  assert.equal(evidence.allowanceStageStartAt,1_800_000_000_000);
});

test('an earlier reservation is checked against every later cumulative boundary', () => {
  const publicTask=base({qty:7,allowanceScope:'contract_cumulative',allowanceMaxPerWallet:'10'});
  const earlier=base({qty:1,allowanceStageStartAt:Date.parse('2026-09-20T10:00:00Z')});
  assert.deepEqual(enforceScheduleAllowanceEnvelope([publicTask],earlier),{
    enforced:true,minted:'2',boundaries:1,
  });
  assert.throws(()=>enforceScheduleAllowanceEnvelope([publicTask],{...earlier,qty:2}),error=>{
    assert.equal(error.code,'SCHEDULE_ALLOWANCE_EXCEEDED');
    assert.equal(error.details.remaining,'1');
    assert.equal(error.details.maximum,'10');
    assert.equal(error.details.minted,'2');
    assert.equal(error.details.reserved,'7');
    return true;
  });
});

test('a known boundary fails closed when its current minted count cannot be refreshed', () => {
  const boundary=base({qty:1,allowanceScope:'contract_cumulative',allowanceMaxPerWallet:'10'});
  assert.throws(()=>enforceScheduleAllowanceEnvelope([boundary],base({allowanceMintedSnapshot:null})),
    error=>error.code==='SCHEDULE_ALLOWANCE_UNAVAILABLE');
});

test('a later task does not consume an earlier stage boundary', () => {
  const earlyBoundary=base({qty:7,allowanceScope:'contract_cumulative',allowanceMaxPerWallet:'10'});
  const later=base({qty:2,allowanceMintedSnapshot:null,
    allowanceStageStartAt:Date.parse('2026-09-21T12:00:00Z')});
  assert.deepEqual(enforceScheduleAllowanceEnvelope([earlyBoundary],later),{enforced:false});
});
