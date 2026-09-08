const assert = require('node:assert/strict');
const test = require('node:test');
const { Interface, parseEther, parseUnits } = require('ethers');
const { ValidationError } = require('../src/validation/domain');
const { ARCHETYPE_INTERFACE } = require('../src/mint/seaDropCall');
const { CANONICAL_SEADROP_CORE_ADDRESS, SEADROP_CORE_INTERFACE } = require('../src/mint/seaDropRegistry');
const { createSniperService } = require('../src/sniper/sniperService');

const USER = '11111111-1111-4111-8111-111111111111';
const SNIPER = '22222222-2222-4222-8222-222222222222';
const SOURCE = `0x${'12'.repeat(32)}`;
const BLOCK = `0x${'34'.repeat(32)}`;
const CONTRACT = '0x0000000000000000000000000000000000000011';
const DENIED = '0x0000000000000000000000000000000000000022';
const FIRING = '0x0000000000000000000000000000000000000044';
const WATCHED_RECIPIENT = '0x0000000000000000000000000000000000000055';
const MINT_INTERFACE = new Interface(['function mint(uint256)','function mint(address,uint256)']);
const APPROVAL_INTERFACE = new Interface(['function approve(address,uint256)']);

function sniper(overrides = {}) {
  return { id:SNIPER, userId:USER, label:'Copy target', targetAddress:'0x0000000000000000000000000000000000000033',
    chain:'ethereum', walletLabel:'Primary', valueMode:'copy', fixedValueETH:0, maxValueETH:0.1,
    gasBoostPercent:20, maxGasGwei:100, dailySpendingCapETH:0.25, cooldownMs:60_000,
    maxAttempts:3, contractAllowlist:[], contractDenylist:[], sourceConfirmations:2, active:true,
    hits:0, fails:0, lastFiredAt:null, ...overrides };
}

function source(overrides = {}) {
  return { hash:SOURCE, to:CONTRACT, data:MINT_INTERFACE.encodeFunctionData('mint(uint256)',[1]),
    value:parseEther('0.01'), gasPrice:parseUnits('2','gwei'), gasLimit:100_000n,
    blockNumber:10, blockHash:BLOCK, ...overrides };
}

class MemoryRepository {
  constructor(events = new Map()) { this.events = events; this.transitions = []; this.spend = 0n; }
  key(event) { return `${event.userId}:${event.sniperId}:${event.txHash}`; }
  async detect(value, tx) {
    const event = { userId:value.userId, sniperId:value.id, txHash:tx.hash, state:'detected', sourceBlockNumber:tx.blockNumber,
      sourceBlockHash:tx.blockHash, contractAddress:tx.to, observationMode:value.observationMode||'confirmed',
      sourceKey:(value.observationMode||'confirmed')==='pending'&&tx.from&&tx.nonce!==undefined?`${tx.from.toLowerCase()}:${tx.nonce}`:null,
      attemptCount:0, transactionIntentId:null };
    const key = this.key(event);
    if (this.events.has(key)||event.sourceKey&&[...this.events.values()].some(item=>item.userId===event.userId
      &&item.sniperId===event.sniperId&&item.sourceKey===event.sourceKey)) return null;
    this.events.set(key, event); return { ...event };
  }
  async listReady(chain, block, snipers) { return [...this.events.values()].filter(event => event.state === 'detected'
    && (event.observationMode === 'pending'
      || event.sourceBlockNumber + snipers.find(item => item.id === event.sniperId).sourceConfirmations - 1 <= block)).map(event => ({ ...event })); }
  async listSubmitted() { return [...this.events.values()].filter(event=>event.state==='submitted').map(event=>({...event})); }
  async claim(event, options) { const stored=this.events.get(this.key(event)); const max=typeof options==='number'?options:options.maxAttempts;
    if(stored.state!=='detected'||stored.attemptCount>=max)return {event:null,reason:null,terminal:false};
    stored.state='submitted'; stored.attemptCount+=1; return { event:{...stored},reason:null,terminal:false }; }
  async transition(event, state, details={}) { const stored=this.events.get(this.key(event));
    if(details.expectedStates&&!details.expectedStates.includes(stored.state))return null;
    Object.assign(stored, details, { state });
    this.transitions.push([state,details]); return { ...stored }; }
  async attachIntent(event,intentId,valueWei){const stored=this.events.get(this.key(event));stored.transactionIntentId=intentId;stored.copiedValueWei=valueWei;return{...stored};}
  async requeueRetryable(event,max) { const stored=this.events.get(this.key(event)); if(stored.attemptCount<max)stored.state='detected'; return { ...stored }; }
  async dailySpendWei() { return this.spend; }
}

function fixture(options = {}) {
  const repository = options.repository || new MemoryRepository();
  let submissions = 0;
  const requests=[];
  const service = createSniperService({ repository, supportedChains:['ethereum'], now:() => options.now ?? 1_000_000,
    transactionEngine:{ submit:async request => { submissions += 1; requests.push(request); if(options.error) throw options.error;
      if(request.onIntentPersisted)await request.onIntentPersisted({intentId:`intent-${submissions}`});
      return { intentId:`intent-${submissions}`, txHash:`0x${'ab'.repeat(32)}`, state:'confirmed', request }; } },
    onEvent:options.onEvent,beforeExecute:options.beforeExecute });
  return { repository, service, submissions:() => submissions, requests };
}

test('duplicate delivery and simulated restart cannot copy a source transaction twice', async () => {
  const first = fixture();
  const s = sniper(); const tx=source();
  const event = await first.service.detect(s, tx);
  assert.equal(await first.service.detect(s, tx), null);
  await first.service.execute(s, event, tx, {address:FIRING}, async () => ({ status:1, blockHash:BLOCK }));
  assert.equal(first.submissions(), 1);
  const restarted = fixture({ repository:first.repository });
  assert.equal(await restarted.service.detect(s, tx), null);
  assert.equal(restarted.submissions(), 0);
});

test('a reorg-dropped source is skipped without submitting or being marked copied', async () => {
  const f=fixture(); const s=sniper(); const tx=source(); const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>null),'skipped');
  assert.equal(f.submissions(),0);
  assert.equal(f.repository.events.get(f.repository.key(event)).state,'skipped');
  assert.match(f.repository.transitions.at(-1)[1].skipReason,/reorganization/);
});

test('pending-mempool mode executes without pretending an unavailable source receipt exists', async () => {
  const f=fixture();
  const s=sniper({observationMode:'pending'});
  const tx=source({blockNumber:null,blockHash:null,from:s.targetAddress,nonce:7});
  const event=await f.service.detect(s,tx);
  let receiptChecks=0;
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>{receiptChecks+=1;return null;}),'confirmed');
  assert.equal(receiptChecks,0);
  assert.equal(f.submissions(),1);
});

test('missing source fee details fail closed before cap checks or broadcast', async () => {
  const f=fixture();
  const s=sniper({observationMode:'pending'});
  const tx=source({blockNumber:null,blockHash:null,from:s.targetAddress,nonce:8,gasPrice:null,maxFeePerGas:null});
  const event=await f.service.detect(s,tx);
  assert.equal(await f.service.processPending(s,event,tx,{address:FIRING}),'skipped');
  assert.equal(f.submissions(),0);
  assert.match(f.repository.transitions.at(-1)[1].skipReason,/fee details are unavailable/);
});

test('pending replacement hashes with the same source sender and nonce are one source action',async()=>{
  const f=fixture();const s=sniper({observationMode:'pending'});
  const base={blockNumber:null,blockHash:null,from:s.targetAddress,nonce:19};
  assert.ok(await f.service.detect(s,source(base)));
  assert.equal(await f.service.detect(s,source({...base,hash:`0x${'77'.repeat(32)}`})),null);
});

test('malformed sniper patches are rejected before mutation', () => {
  const f=fixture(); const current=sniper();
  assert.throws(() => f.service.validatePatch(current,{ targetAddress:'bad' }),ValidationError);
  assert.throws(() => f.service.validatePatch(current,{ maxAttempts:0 }),ValidationError);
  assert.throws(() => f.service.validatePatch(current,{ active:'yes' }),ValidationError);
  assert.throws(() => f.service.validatePatch(current,{ observationMode:'instant' }),ValidationError);
  assert.equal(current.targetAddress,sniper().targetAddress);
});

test('value, gas, daily cap, cooldown, max attempts, and denylist limits are enforced', async t => {
  const cases = [
    ['value',sniper({maxValueETH:0.001}),source(),{},/maximum copied value/],
    ['gas',sniper({maxGasGwei:1}),source(),{},/maximum gas price/],
    ['daily',sniper({dailySpendingCapETH:0.01}),source(),{spend:parseEther('0.01')},/daily sniper/],
    ['cooldown',sniper({lastFiredAt:999_500,cooldownMs:1_000}),source(),{},/cooldown/],
    ['denylist',sniper({contractDenylist:[DENIED]}),source({to:DENIED}),{},/denylisted/],
  ];
  for (const [name,s,tx,setup,reason] of cases) await t.test(name,async()=>{
    const f=fixture(); f.repository.spend=setup.spend||0n; const event=await f.service.detect(s,tx);
    assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'skipped');
    assert.equal(f.submissions(),0); assert.match(f.repository.transitions.at(-1)[1].skipReason,reason);
  });
  await t.test('max attempts',async()=>{
    const f=fixture(); const s=sniper({maxAttempts:1}); const tx=source(); const event=await f.service.detect(s,tx);
    f.repository.events.get(f.repository.key(event)).attemptCount=1;
    assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'duplicate');
    assert.equal(f.submissions(),0);
  });
});

test('one sniper failure is isolated while another ready sniper continues', async () => {
  const f=fixture(); const first=sniper({id:SNIPER}); const second=sniper({id:'33333333-3333-4333-8333-333333333333'});
  const tx1=source(); const tx2=source({hash:`0x${'56'.repeat(32)}`});
  await f.service.detect(first,tx1); await f.service.detect(second,tx2);
  const results=await f.service.processBlock('ethereum',11,[first,second],async hash=>{
    if(hash===SOURCE)throw new Error('isolated provider decode error'); return tx2;
  },async()=>({status:1,blockHash:BLOCK}),()=>({address:FIRING}));
  assert.equal(results.length,2);
  assert.equal(results[0].status,'rejected');
  assert.equal(results[1].status,'fulfilled');
  assert.equal(f.submissions(),1);
});

test('a submitted copy is reconciled after restart instead of resubmitted', async () => {
  const repository=new MemoryRepository(); const s=sniper(); const tx=source();
  const detected=await repository.detect(s,tx); const submitted=(await repository.claim(detected,3)).event;
  submitted.transactionIntentId='intent-existing'; repository.events.get(repository.key(submitted)).transactionIntentId='intent-existing';
  let submissions=0; let reconciliations=0;
  const service=createSniperService({repository,supportedChains:['ethereum'],
    intentRepository:{get:async()=>({intentId:'intent-existing',state:'pending',txHash:`0x${'ab'.repeat(32)}`}),getByIdempotencyKey:async()=>null},
    transactionEngine:{submit:async()=>{submissions+=1;},reconcileIntent:async intent=>{reconciliations+=1;return{...intent,state:'confirmed'};}},
  });
  await service.processBlock('ethereum',11,[s],async()=>tx,async()=>({status:1,blockHash:BLOCK}),()=>({address:FIRING}));
  assert.equal(reconciliations,1);
  assert.equal(submissions,0);
  assert.equal(repository.events.get(repository.key(submitted)).state,'confirmed');
});

test('an intent persisted before signing is finalized unbroadcast and retried with a new attempt key',async()=>{
  const repository=new MemoryRepository();const s=sniper({observationMode:'pending',cooldownMs:0});
  const tx=source({from:s.targetAddress,nonce:44,blockNumber:null,blockHash:null});
  const detected=await repository.detect(s,tx);const submitted=(await repository.claim(detected,3)).event;
  submitted.transactionIntentId='intent-unbroadcast';
  repository.events.get(repository.key(submitted)).transactionIntentId='intent-unbroadcast';
  const finalized=[];const requests=[];
  const service=createSniperService({repository,supportedChains:['ethereum'],
    intentRepository:{get:async()=>({intentId:'intent-unbroadcast',state:'submitted',txHash:null}),
      getByIdempotencyKey:async()=>null,transition:async(id,state,details)=>finalized.push({id,state,details})},
    transactionEngine:{reconcileIntent:async value=>value,submit:async request=>{requests.push(request);
      await request.onIntentPersisted({intentId:'intent-retry'});return{intentId:'intent-retry',state:'confirmed'};}},
  });
  await service.processBlock('ethereum',20,[s],async()=>tx,async()=>null,()=>({address:FIRING}));
  assert.equal(finalized[0].state,'reverted');
  assert.equal(requests.length,1);
  assert.match(requests[0].idempotencyKey,/attempt:2$/);
  assert.equal(repository.events.get(repository.key(submitted)).state,'confirmed');
});

test('copy-mint rejects arbitrary calls before claim or broadcast',async()=>{
  const f=fixture();const s=sniper();const tx=source({
    data:APPROVAL_INTERFACE.encodeFunctionData('approve',[WATCHED_RECIPIENT,1]),value:0n,
  });
  const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'skipped');
  assert.equal(f.submissions(),0);
  assert.match(f.repository.transitions.at(-1)[1].skipReason,/not one of GhostMint's recognized mint methods/);
});

test('recipient-bearing mint calldata is reconstructed for the firing wallet',async()=>{
  const f=fixture();const s=sniper();const tx=source({
    data:MINT_INTERFACE.encodeFunctionData('mint(address,uint256)',[WATCHED_RECIPIENT,2]),
  });
  const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'confirmed');
  const decoded=MINT_INTERFACE.decodeFunctionData('mint(address,uint256)',f.requests[0].data);
  assert.equal(decoded[0].toLowerCase(),FIRING.toLowerCase());
  assert.equal(decoded[1],2n);
});

test('fixed-value copies expose the actual copied value in confirmation and intent previews',async()=>{
  let beforeExecute;
  const f=fixture({beforeExecute:async value=>{beforeExecute=value;return true;}});
  const s=sniper({valueMode:'fixed',fixedValueETH:0.02});const tx=source({value:parseEther('0.01')});
  const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'confirmed');
  assert.equal(beforeExecute.value,parseEther('0.02'));
  assert.equal(beforeExecute.prepared.preview.nativeValueWei,parseEther('0.02').toString());
  assert.equal(f.requests[0].valueWei,parseEther('0.02'));
  assert.equal(f.requests[0].callPreview.nativeValue,'0.02');
});

test('copy-mint accepts canonical public SeaDrop calls and rewrites the minter',async()=>{
  const f=fixture();const s=sniper();
  const data=SEADROP_CORE_INTERFACE.encodeFunctionData('mintPublic',[
    CONTRACT,WATCHED_RECIPIENT,WATCHED_RECIPIENT,2,
  ]);
  const tx=source({to:CANONICAL_SEADROP_CORE_ADDRESS,data});
  const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'confirmed');
  const decoded=SEADROP_CORE_INTERFACE.decodeFunctionData('mintPublic',f.requests[0].data);
  assert.equal(f.requests[0].to.toLowerCase(),CANONICAL_SEADROP_CORE_ADDRESS.toLowerCase());
  assert.equal(decoded[0].toLowerCase(),CONTRACT.toLowerCase());
  assert.equal(decoded[2].toLowerCase(),FIRING.toLowerCase());
  assert.equal(decoded[3],2n);
});

test('copy-mint rejects fake SeaDrop targets and wallet-bound authorization',async t=>{
  await t.test('same-selector fake SeaDrop target',async()=>{
    const f=fixture();const s=sniper();
    const data=SEADROP_CORE_INTERFACE.encodeFunctionData('mintPublic',[
      CONTRACT,WATCHED_RECIPIENT,WATCHED_RECIPIENT,1,
    ]);
    const tx=source({to:DENIED,data});const event=await f.service.detect(s,tx);
    assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'skipped');
    assert.equal(f.submissions(),0);
    assert.match(f.repository.transitions.at(-1)[1].skipReason,/canonical SeaDrop core/);
  });
  await t.test('proof-bearing standard mint',async()=>{
    const f=fixture();const s=sniper();
    const allowlist=new Interface(['function mint(uint256,bytes32[])']);
    const tx=source({data:allowlist.encodeFunctionData('mint',[1,[`0x${'aa'.repeat(32)}`]])});
    const event=await f.service.detect(s,tx);
    assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'skipped');
    assert.equal(f.submissions(),0);
    assert.match(f.repository.transitions.at(-1)[1].skipReason,/authorization belongs to the watched wallet/);
  });
  await t.test('gated Archetype mint',async()=>{
    const f=fixture();const s=sniper();
    const auth={key:`0x${'bb'.repeat(32)}`,proof:[`0x${'cc'.repeat(32)}`]};
    const tx=source({data:ARCHETYPE_INTERFACE.encodeFunctionData('mint',[auth,1,WATCHED_RECIPIENT,'0x1234'])});
    const event=await f.service.detect(s,tx);
    assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'skipped');
    assert.equal(f.submissions(),0);
    assert.match(f.repository.transitions.at(-1)[1].skipReason,/authorization belongs to the watched wallet/);
  });
});

test('a failed cross-platform notification cannot alter a confirmed copy state',async()=>{
  const f=fixture({onEvent:async()=>{throw new Error('Telegram and Discord unavailable');}});
  const s=sniper();const tx=source();const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{address:FIRING},async()=>({status:1,blockHash:BLOCK})),'confirmed');
  assert.equal(f.repository.events.get(f.repository.key(event)).state,'confirmed');
  assert.equal(f.repository.events.get(f.repository.key(event)).failureReason,undefined);
});

test('a pending transient failure is retried from durable detected state on a later block',async()=>{
  const repository=new MemoryRepository();const s=sniper({observationMode:'pending',cooldownMs:0});
  const tx=source({blockNumber:null,blockHash:null,from:s.targetAddress,nonce:9});
  const first=fixture({repository,error:Object.assign(new Error('temporary RPC outage'),{code:'RPC_UNAVAILABLE'})});
  const event=await first.service.detect(s,tx);
  assert.equal(await first.service.processPending(s,event,tx,{address:FIRING}),'failed');
  assert.equal(repository.events.get(repository.key(event)).state,'detected');
  const restarted=fixture({repository});
  await restarted.service.processBlock('ethereum',20,[s],async()=>tx,async()=>null,()=>({address:FIRING}));
  assert.equal(restarted.submissions(),1);
  assert.equal(repository.events.get(repository.key(event)).state,'confirmed');
});
