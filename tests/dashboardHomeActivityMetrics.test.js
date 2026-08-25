const assert=require('node:assert/strict');
const path=require('node:path');
const test=require('node:test');
const {pathToFileURL}=require('node:url');

const moduleUrl=pathToFileURL(path.join(__dirname,'..','dashboard','src','homeActivityMetrics.js')).href;

async function metrics(){
  return import(moduleUrl);
}

test('home success summary counts only final broadcast outcomes',async()=>{
  const {broadcastOutcomeSummary}=await metrics();
  const result=broadcastOutcomeSummary([
    {title:'Minted one',status:'Success',txHash:'0x01'},
    {title:'Minted another',status:'CONFIRMED',txHash:'0x02'},
    {title:'Mint reverted',status:'ReVeRtEd',txHash:'0x03'},
    {title:'Mint failed',status:'failure',txHash:'0x04'},
    {title:'Preview blocked',status:'failed',txHash:null},
    {title:'Schedule expired',status:'fail'},
    {title:'Mint submitted',status:'submitted',txHash:'0x05'},
    {title:'Mint unknown',status:'unknown',txHash:'0x06'},
    {title:'Mint replaced',status:'replaced',txHash:'0x07'},
    {title:'Watcher health',status:'healthy'},
  ]);

  assert.deepEqual(result,{successRate:50,successCount:2,successScopeSize:4});
});

test('home success summary filters before taking the newest twenty outcomes',async()=>{
  const {broadcastOutcomeSummary}=await metrics();
  const ignored=Array.from({length:25},(_,index)=>({
    title:`Safely blocked ${index}`,
    status:index%2?'failed':'submitted',
    txHash:index%2?null:`0xignored${index}`,
  }));
  const broadcasts=Array.from({length:21},(_,index)=>({
    title:`Mint ${index}`,
    status:index===19?'failed':'confirmed',
    txHash:`0x${index}`,
  }));

  assert.deepEqual(broadcastOutcomeSummary([...ignored,...broadcasts]),{
    successRate:95,
    successCount:19,
    successScopeSize:20,
  });
});

test('home success summary has no percentage when nothing was broadcast',async()=>{
  const {broadcastOutcomeSummary}=await metrics();
  assert.deepEqual(broadcastOutcomeSummary([
    {title:'Validation stopped mint',status:'failed'},
    {title:'Pending mint',status:'submitted',txHash:'0xpending'},
  ]),{successRate:null,successCount:0,successScopeSize:0});
});

test('success streak ignores non-final rows and stops at the first final failure',async()=>{
  const {broadcastSuccessStreak}=await metrics();
  assert.equal(broadcastSuccessStreak([
    {title:'Newest mint',status:'success',txHash:'0x01'},
    {title:'Notification row',status:'healthy'},
    {title:'Second mint',status:'confirmed',txHash:'0x02'},
    {title:'Blocked preview',status:'failed'},
    {title:'Still pending',status:'submitted',txHash:'0x03'},
    {title:'On-chain failure',status:'FAILED',txHash:'0x04'},
    {title:'Older mint',status:'success',txHash:'0x05'},
  ]),2);
});

test('latest confirmed mint requires a final success, transaction hash and mint title',async()=>{
  const {latestConfirmedMint}=await metrics();
  const expected={id:'winner',title:'Scheduled MINT confirmed',status:'Confirmed',txHash:'0x04'};
  assert.equal(latestConfirmedMint([
    {id:'health',title:'RPC health',status:'success',txHash:'0x01'},
    {id:'failed',title:'Mint failed',status:'failure',txHash:'0x02'},
    {id:'no-hash',title:'Minted locally',status:'success'},
    {id:'pending',title:'Mint submitted',status:'submitted',txHash:'0x03'},
    expected,
    {id:'older',title:'Minted older NFT',status:'success',txHash:'0x05'},
  ]),expected);
  assert.equal(latestConfirmedMint(null),null);
});

