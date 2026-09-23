'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenSeaScheduleTaskData } = require('../src/mint/openSeaScheduleDraft');

const START = 1_900_000_000;

test('Telegram and Discord share one gated-stage task draft with a bounded eligibility deadline',()=>{
  const allow={uuid:'allow-1',label:'Allowlist',stageType:'allowlist',startTime:START,endTime:START+600,
    priceWei:'1000000000000000',maxPerWallet:2};
  const publicStage={uuid:'public-1',label:'Public',stageType:'public_sale',startTime:START+600,
    endTime:START+3600,priceWei:'2000000000000000',maxPerWallet:10};
  const data={contractAddress:'0x0000000000000000000000000000000000000001',chain:'ethereum',
    isSeaDrop:true,collection:{name:'Example'},drop:{stages:[allow,publicStage]},
    schedulePlan:{recommendedStageUuid:'allow-1'}};
  const draft=buildOpenSeaScheduleTaskData(data,allow);
  assert.equal(draft.name,'Example — Allowlist');
  assert.equal(draft.stageUuid,'allow-1');
  assert.equal(draft.eligibilityMode,'earliest_eligible');
  assert.equal(draft.viaOpenSea,true);
  assert.equal(draft.priceETH,0);
  assert.equal(draft.maxPerWallet,2);
  assert.equal(draft.eligibilityDeadline,new Date((START+3600)*1000).toISOString());
});

test('a public SeaDrop stage stays pinned and uses its own detected price and quantity cap',()=>{
  const publicStage={uuid:'public-1',label:'Public',stageType:'public_sale',startTime:START,
    endTime:START+3600,priceWei:'2500000000000000',maxPerWallet:7};
  const draft=buildOpenSeaScheduleTaskData({
    contractAddress:'0x0000000000000000000000000000000000000001',chain:'base',isSeaDrop:true,
    maxPerWallet:1,drop:{stages:[publicStage]},
  },publicStage);
  assert.equal(draft.eligibilityMode,'specific_stage');
  assert.equal(draft.viaOpenSea,false);
  assert.equal(draft.priceETH,0.0025);
  assert.equal(draft.maxPerWallet,7);
});

test('an open-ended later public stage keeps earliest-eligible scheduling alive until the bounded deadline',()=>{
  const allow={uuid:'allow-1',label:'Allowlist',stageType:'allowlist',startTime:START,
    endTime:START+600,priceWei:'0',maxPerWallet:1};
  const publicStage={uuid:'public-1',label:'Public',stageType:'public_sale',
    startTime:START+3600,endTime:null,priceWei:'0',maxPerWallet:10};
  const draft=buildOpenSeaScheduleTaskData({
    contractAddress:'0x0000000000000000000000000000000000000001',chain:'ethereum',isSeaDrop:true,
    drop:{stages:[allow,publicStage]},
  },allow);
  assert.equal(draft.eligibilityDeadline,new Date((START+24*60*60)*1000).toISOString());
});

test('a phase opening exactly at the 24-hour deadline is not promised as reachable',()=>{
  const allow={uuid:'allow-1',label:'Allowlist',stageType:'allowlist',startTime:START,
    endTime:START+600,priceWei:'0',maxPerWallet:1};
  const tooLate={uuid:'public-1',label:'Public',stageType:'public_sale',
    startTime:START+24*60*60,endTime:null,priceWei:'0',maxPerWallet:10};
  const draft=buildOpenSeaScheduleTaskData({
    contractAddress:'0x0000000000000000000000000000000000000001',chain:'ethereum',isSeaDrop:true,
    drop:{stages:[allow,tooLate]},
  },allow);
  assert.equal(draft.eligibilityDeadline,new Date((START+600)*1000).toISOString());
  assert.ok(Date.parse(draft.eligibilityDeadline)<tooLate.startTime*1000);
});
