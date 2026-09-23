const assert=require('node:assert/strict');
const path=require('node:path');
const test=require('node:test');
const {pathToFileURL}=require('node:url');
const {requestSchemas}=require('../src/validation/domain');

const root=path.join(__dirname,'..');

test('a detected stage with seconds keeps its exact opening boundary in the schedule payload',async()=>{
  const {stageMintTimeLocalValue}=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleTime.mjs')));
  // Rare Friends Genesis opens at 04:00:20Z. The old minute-only conversion submitted 04:00:00Z.
  const stageStartSeconds=Date.parse('2026-09-15T04:00:20.000Z')/1000;
  const localValue=stageMintTimeLocalValue(stageStartSeconds);
  const submittedMintTime=new Date(localValue).toISOString();

  assert.equal(Date.parse(submittedMintTime),stageStartSeconds*1000+15_000);
  const validated=requestSchemas.taskCreate({
    name:'Rare Friends Genesis',walletLabel:'Trading',
    contractAddress:'0x116eaa62241751e0c98da43d458600c6c17cd361',
    chain:'robinhood',quantity:1,priceETH:0,mintTime:submittedMintTime,
    stageStartAt:new Date(stageStartSeconds*1000).toISOString(),stageType:'public',
  },{supportedChains:['robinhood'],now:stageStartSeconds*1000-60_000});

  assert.ok(validated.mintTime>=validated.stageStartAt);
});

test('the selected stage minimum retains provider seconds instead of rounding backward',async()=>{
  const {stageMintTimeLocalValue}=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleTime.mjs')));
  const stageStartSeconds=Date.parse('2026-09-15T04:00:20.000Z')/1000;
  assert.equal(new Date(stageMintTimeLocalValue(stageStartSeconds,{bufferMs:0})).toISOString(),
    '2026-09-15T04:00:20.000Z');
});
