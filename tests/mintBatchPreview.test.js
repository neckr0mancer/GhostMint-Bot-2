'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

async function loadModel(){return import('../dashboard/src/mintBatchPreview.mjs');}

function ready(label,{chain='ethereum',value='0',gas='0',total='0',balance='0'}={}){
  return {wallet:{label,chain},chain,preview:{nativeValueWei:value},simulation:{
    estimatedGasCostWei:gas,estimatedCostWei:total,balanceWei:balance,
  }};
}

test('batch preview sums wei exactly with BigInt',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[
    ready('alpha',{value:'9007199254740993',gas:'7',total:'9007199254741000',balance:'9007199254742000'}),
    ready('beta',{value:'20',gas:'30',total:'50',balance:'100'}),
  ]},selectedLabels:['alpha','beta']});
  const [group]=model.groups;
  assert.equal(group.readyMintValue.wei,'9007199254741013');
  assert.equal(group.readyEstimatedGas.wei,'37');
  assert.equal(group.readyEstimatedDebit.wei,'9007199254741050');
  assert.equal(group.combinedBalance.wei,'9007199254742100');
});

test('one underfunded wallet stays blocked even when the combined balance is ample',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{
    items:[ready('wealthy',{gas:'10',total:'10',balance:'1000'})],
    failures:[{walletLabel:'poor',chain:'ethereum',code:'INSUFFICIENT_BALANCE',error:'balance is below cost',
      preview:{nativeValueWei:'0'},details:{estimatedGasCostWei:'5',estimatedCostWei:'5',balanceWei:'0'}}],
  },selectedLabels:['poor','wealthy']});
  assert.equal(model.canConfirm,true);
  assert.equal(model.readyCount,1);
  assert.equal(model.blockedCount,1);
  assert.equal(model.hasUnderfundedWallet,true);
  assert.equal(model.underfundedCount,1);
  assert.deepEqual(model.rows.map(row=>[row.label,row.status,row.funding]),[
    ['poor','blocked','underfunded'],['wealthy','ready','sufficient'],
  ]);
  assert.equal(model.groups[0].combinedBalance.wei,'1000');
  assert.equal(model.groups[0].readyEstimatedDebit.wei,'10');
});

test('unknown values make their aggregates incomplete instead of becoming zero',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[
    ready('known',{value:'1',gas:'2',total:'3',balance:'100'}),
    {wallet:{label:'unknown',chain:'ethereum'},chain:'ethereum',preview:{}},
  ]},selectedLabels:['known','unknown']});
  const [group]=model.groups;
  assert.equal(group.combinedBalance.wei,null);
  assert.equal(group.combinedBalance.knownWei,'100');
  assert.equal(group.combinedBalance.complete,false);
  assert.equal(group.combinedBalance.unknownCount,1);
  assert.equal(group.readyEstimatedGas.wei,null);
  assert.equal(group.readyEstimatedGas.knownWei,'2');
  assert.equal(group.readyEstimatedGas.unknownCount,1);
});

test('free mint value remains a known zero while gas and debit still sum',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[
    ready('one',{value:'0',gas:'2',total:'2',balance:'10'}),
    ready('two',{value:'0',gas:'3',total:'3',balance:'10'}),
  ]}});
  assert.equal(model.groups[0].readyMintValue.wei,'0');
  assert.equal(model.groups[0].readyEstimatedGas.wei,'5');
  assert.equal(model.groups[0].readyEstimatedDebit.wei,'5');
  assert.deepEqual(model.rows.map(row=>row.methodSignature),['','']);
});

test('the aggregate keeps the real prepared method for OpenSea and other detected calls',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[
    {...ready('one'),preview:{nativeValueWei:'0',methodSignature:'mintPublic(address,uint256,uint256,bytes32[],uint256)'}},
    {...ready('two'),preview:{nativeValueWei:'0',methodSignature:'mintPublic(address,uint256,uint256,bytes32[],uint256)'}},
  ]}});
  assert.deepEqual(model.rows.map(row=>row.methodSignature),[
    'mintPublic(address,uint256,uint256,bytes32[],uint256)',
    'mintPublic(address,uint256,uint256,bytes32[],uint256)',
  ]);
});

test('same-symbol networks and different native assets are never pooled together',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[
    ready('eth',{chain:'ethereum',total:'1',balance:'10'}),
    ready('base',{chain:'base',total:'2',balance:'20'}),
    ready('polygon',{chain:'polygon',total:'3',balance:'30'}),
  ]}});
  assert.deepEqual(model.groups.map(group=>[group.chain,group.symbol,group.readyEstimatedDebit.wei]),[
    ['ethereum','ETH','1'],['base','ETH','2'],['polygon','MATIC','3'],
  ]);
});

test('an all-blocked or missing preview has no confirmable wallet and preserves selection order',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{items:[],failures:[{walletLabel:'first',error:'not eligible'}]},
    selectedLabels:['second','first'],failureReason:value=>value.error});
  assert.equal(model.canConfirm,false);
  assert.equal(model.readyCount,0);
  assert.equal(model.blockedCount,2);
  assert.deepEqual(model.rows.map(row=>[row.label,row.status,row.reason]),[
    ['second','blocked','Preview result unavailable.'],['first','blocked','not eligible'],
  ]);
  assert.equal(model.groups[0].readyMintValue.wei,null);
  assert.equal(model.groups[0].readyEstimatedGas.wei,null);
  assert.equal(model.groups[0].readyEstimatedDebit.wei,null);
});

test('one wrong-price contract failure is shown once for the whole all-blocked batch',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const failures=['alpha','beta'].map(walletLabel=>({walletLabel,chain:'robinhood',code:'SIMULATION_FAILED',
    error:'execution reverted: incorrect payment',details:{balanceWei:'100'}}));
  const model=mintBatchPreviewModel({preview:{items:[],failures},selectedLabels:['alpha','beta'],
    failureReason:()=> 'The mint price is incorrect. Check the price and try again.'});
  assert.deepEqual(model.sharedIssue,{
    scope:'mint',reason:'The mint price is incorrect. Check the price and try again.',count:2,
    code:'SIMULATION_FAILED',groupKey:'robinhood:ETH',
  });
  assert.deepEqual(model.rows.map(row=>row.failureScope),['mint','mint']);
});

test('matching wallet-specific or ambiguous failures collapse repeated copy without becoming a shared mint issue',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const insufficient=mintBatchPreviewModel({preview:{items:[],failures:['alpha','beta'].map(walletLabel=>({
    walletLabel,chain:'ethereum',code:'INSUFFICIENT_BALANCE',error:'balance is below cost',
  }))},selectedLabels:['alpha','beta'],failureReason:()=> 'Not enough ETH for this mint.'});
  assert.equal(insufficient.sharedIssue,null);
  assert.equal(insufficient.commonIssue.scope,'wallet');
  assert.equal(insufficient.commonIssue.count,2);
  assert.deepEqual(insufficient.rows.map(row=>row.failureScope),['wallet','wallet']);

  const ambiguous=mintBatchPreviewModel({preview:{items:[],failures:['alpha','beta'].map(walletLabel=>({
    walletLabel,chain:'ethereum',code:'SIMULATION_FAILED',error:'execution reverted',
  }))},selectedLabels:['alpha','beta'],failureReason:()=> 'This mint would fail.'});
  assert.equal(ambiguous.sharedIssue,null);
  assert.deepEqual(ambiguous.commonIssue,{
    scope:'unknown',reason:'This mint would fail.',count:2,code:'SIMULATION_FAILED',groupKey:'ethereum:ETH',
  });
  assert.deepEqual(ambiguous.rows.map(row=>row.failureScope),['unknown','unknown']);
});

test('the exact generic preview failure is rendered once without inventing its cause',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const reason='We could not preview this mint. Check the contract details and try again.';
  const model=mintBatchPreviewModel({preview:{items:[],failures:['alpha','beta'].map(walletLabel=>({
    walletLabel,chain:'ink',error:'unclassified provider response',
  }))},selectedLabels:['alpha','beta'],failureReason:()=>reason});
  assert.deepEqual(model.commonIssue,{
    scope:'unknown',reason,count:2,code:null,groupKey:'ink:ETH',
  });
  assert.equal(model.sharedIssue,null);
  assert.equal(model.rows.filter(row=>row.reason===model.commonIssue.reason).length,2);
  assert.ok(model.rows.every(row=>row.failureScope==='unknown'));
});

test('a ready wallet prevents a contract failure from being described as batch-wide',async()=>{
  const {mintBatchPreviewModel}=await loadModel();
  const model=mintBatchPreviewModel({preview:{
    items:[ready('alpha',{chain:'ethereum',balance:'100',total:'1'})],
    failures:[{walletLabel:'beta',chain:'ethereum',code:'MINT_SOLD_OUT',error:'sold out'}],
  },selectedLabels:['alpha','beta'],failureReason:()=> 'This mint is sold out.'});
  assert.equal(model.sharedIssue,null);
  assert.equal(model.groups[0].sharedIssue,null);
});
