const assert = require('node:assert/strict');
const test = require('node:test');
const { Interface } = require('ethers');
const { createEtherscanGasService, GasLookupError } = require('../src/gas/etherscanGasService');
const { createReadinessService } = require('../src/health/readinessService');
const { runAllowlistCheck, validateAllowlistCheck } = require('../src/mint/allowlistCheckRegistry');
const { MAX_PAGE_SIZE, paginate, pagination } = require('../src/pagination');
const { ValidationError } = require('../src/validation/domain');
const { calculateStatistics } = require('../src/statistics/statisticsService');

test('gas lookup uses Etherscan V2 with chain ID and degrades safely', async () => {
  let request;
  const service=createEtherscanGasService({apiKey:'configured-key',chains:{base:{chainId:8453}},http:{
    get:async (...args)=>{request=args;return {data:{status:'1',result:{SafeGasPrice:'0.1',ProposeGasPrice:'0.2',FastGasPrice:'0.3'}}};},
  }});
  assert.equal((await service.lookup('base')).source,'etherscan-v2');
  assert.equal(request[0],'https://api.etherscan.io/v2/api');
  assert.deepEqual(request[1].params,{chainid:'8453',module:'gastracker',action:'gasoracle',apikey:'configured-key'});
  await assert.rejects(createEtherscanGasService({apiKey:null,chains:{base:{chainId:8453}}}).lookup('base'),
    error=>error instanceof GasLookupError&&error.code==='MISSING_API_KEY');
  await assert.rejects(createEtherscanGasService({apiKey:'key',chains:{base:{chainId:8453}},http:{get:async()=>{throw new Error('token=secret');}}}).lookup('base'),
    error=>error.code==='UNAVAILABLE'&&!error.message.includes('secret'));
});

test('skipped events are reported separately and never counted as failures', () => {
  assert.deepEqual(calculateStatistics({activity:[{status:'success'},{status:'fail'}],sniperEvents:[{state:'skipped'},{state:'failed'}]}),
    {success:1,failures:1,skipped:1,attempted:2,successRate:50});
});

test('pagination has exact page boundaries without duplicates or omissions', () => {
  const values=Array.from({length:23},(_,index)=>index+1);
  const pages=[1,2,3].map(page=>paginate(values,{page,pageSize:10}));
  assert.deepEqual(pages.map(value=>value.items.length),[10,10,3]);
  assert.deepEqual(pages.flatMap(value=>value.items),values);
  assert.equal(new Set(pages.flatMap(value=>value.items)).size,23);
});

test('out-of-range pagination is a field-scoped ValidationError, not a bare throw', () => {
  // A page/pageSize off a query string is the caller's input, so a bad one has to be reportable as
  // a client error. These used to throw TypeError, which the dashboard turned into a 500.
  for(const [input,field] of [[{pageSize:MAX_PAGE_SIZE+1},'pageSize'],[{pageSize:0},'pageSize'],
    [{pageSize:1.5},'pageSize'],[{page:0},'page'],[{page:-3},'page'],[{page:'abc'},'page']]){
    assert.throws(()=>pagination(input),error=>{
      assert.ok(error instanceof ValidationError,`${JSON.stringify(input)} should raise ValidationError`);
      assert.deepEqual(error.issues.map(value=>value.field),[field]);
      return true;});
  }
  // The boundary itself stays valid, and omitted values still fall back to the defaults.
  assert.deepEqual(pagination({page:2,pageSize:MAX_PAGE_SIZE}),{page:2,pageSize:MAX_PAGE_SIZE,offset:MAX_PAGE_SIZE});
  assert.deepEqual(pagination(),{page:1,pageSize:10,offset:0});
});

test('readiness distinctly reports database and RPC outages', async () => {
  const worker={health:()=>({status:'up'})};
  const normal=createReadinessService({database:{health:async()=>true},providerService:{perform:async()=>123},chains:['ethereum'],schedulerWorker:worker,socialWatchWorker:worker});
  assert.equal((await normal.inspect()).status,'ok');
  const databaseDown=createReadinessService({database:{health:async()=>{throw new Error('db password');}},providerService:{perform:async()=>123},chains:['ethereum'],schedulerWorker:worker,socialWatchWorker:worker});
  const dbResult=await databaseDown.inspect();
  assert.equal(dbResult.dependencies.database.status,'down');
  assert.equal(dbResult.dependencies.rpc.ethereum.status,'up');
  const rpcDown=createReadinessService({database:{health:async()=>true},providerService:{perform:async()=>{throw new Error('rpc token');}},chains:['ethereum'],schedulerWorker:worker,socialWatchWorker:worker});
  const rpcResult=await rpcDown.inspect();
  assert.equal(rpcResult.dependencies.database.status,'up');
  assert.equal(rpcResult.dependencies.rpc.ethereum.status,'down');
  assert.doesNotMatch(JSON.stringify(rpcResult),/token/);
});

test('allowlist checks accept a validated configurable ABI shape', async () => {
  const fragment={type:'function',name:'canMint',stateMutability:'view',inputs:[{name:'wallet',type:'address'}],outputs:[{name:'allowed',type:'bool'}]};
  const check=validateAllowlistCheck({signature:'canMint(address)',abiFragment:fragment});
  const iface=new Interface([fragment]);
  const result=await runAllowlistCheck({check,chain:'ethereum',contractAddress:'0x00000000000000000000000000000000000000C3',
    walletAddress:'0x00000000000000000000000000000000000000A1',providerService:{perform:async()=>iface.encodeFunctionResult('canMint',[true])}});
  assert.equal(result.eligible,true);
  assert.throws(()=>validateAllowlistCheck({signature:'unsafe(bytes)',abiFragment:{...fragment,inputs:[{name:'data',type:'bytes'}]}}));
});
