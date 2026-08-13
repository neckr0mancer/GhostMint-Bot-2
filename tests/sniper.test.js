const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEther, parseUnits } = require('ethers');
const { ValidationError } = require('../src/validation/domain');
const { createSniperService } = require('../src/sniper/sniperService');

const USER = '11111111-1111-4111-8111-111111111111';
const SNIPER = '22222222-2222-4222-8222-222222222222';
const SOURCE = `0x${'12'.repeat(32)}`;
const BLOCK = `0x${'34'.repeat(32)}`;
const CONTRACT = '0x0000000000000000000000000000000000000011';
const DENIED = '0x0000000000000000000000000000000000000022';

function sniper(overrides = {}) {
  return { id:SNIPER, userId:USER, label:'Copy target', targetAddress:'0x0000000000000000000000000000000000000033',
    chain:'ethereum', walletLabel:'Primary', valueMode:'copy', fixedValueETH:0, maxValueETH:0.1,
    gasBoostPercent:20, maxGasGwei:100, dailySpendingCapETH:0.25, cooldownMs:60_000,
    maxAttempts:3, contractAllowlist:[], contractDenylist:[], sourceConfirmations:2, active:true,
    hits:0, fails:0, lastFiredAt:null, ...overrides };
}

function source(overrides = {}) {
  return { hash:SOURCE, to:CONTRACT, data:'0x1234', value:parseEther('0.01'), gasPrice:parseUnits('2','gwei'),
    blockNumber:10, blockHash:BLOCK, ...overrides };
}

class MemoryRepository {
  constructor(events = new Map()) { this.events = events; this.transitions = []; this.spend = 0n; }
  key(event) { return `${event.userId}:${event.sniperId}:${event.txHash}`; }
  async detect(value, tx) {
    const event = { userId:value.userId, sniperId:value.id, txHash:tx.hash, state:'detected', sourceBlockNumber:tx.blockNumber,
      sourceBlockHash:tx.blockHash, contractAddress:tx.to, attemptCount:0, transactionIntentId:null };
    const key = this.key(event);
    if (this.events.has(key)) return null;
    this.events.set(key, event); return { ...event };
  }
  async listReady(chain, block, snipers) { return [...this.events.values()].filter(event => event.state === 'detected'
    && event.sourceBlockNumber + snipers.find(item => item.id === event.sniperId).sourceConfirmations - 1 <= block).map(event => ({ ...event })); }
  async listSubmitted() { return [...this.events.values()].filter(event=>event.state==='submitted').map(event=>({...event})); }
  async claim(event, max) { const stored=this.events.get(this.key(event)); if(stored.state!=='detected'||stored.attemptCount>=max)return null;
    stored.state='submitted'; stored.attemptCount+=1; return { ...stored }; }
  async transition(event, state, details={}) { const stored=this.events.get(this.key(event)); Object.assign(stored, details, { state });
    this.transitions.push([state,details]); return { ...stored }; }
  async requeueRetryable(event,max) { const stored=this.events.get(this.key(event)); if(stored.attemptCount<max)stored.state='detected'; return { ...stored }; }
  async dailySpendWei() { return this.spend; }
}

function fixture(options = {}) {
  const repository = options.repository || new MemoryRepository();
  let submissions = 0;
  const service = createSniperService({ repository, supportedChains:['ethereum'], now:() => options.now ?? 1_000_000,
    transactionEngine:{ submit:async request => { submissions += 1; if(options.error) throw options.error;
      return { intentId:`intent-${submissions}`, txHash:`0x${'ab'.repeat(32)}`, state:'confirmed', request }; } },
    onEvent:options.onEvent });
  return { repository, service, submissions:() => submissions };
}

test('duplicate delivery and simulated restart cannot copy a source transaction twice', async () => {
  const first = fixture();
  const s = sniper(); const tx=source();
  const event = await first.service.detect(s, tx);
  assert.equal(await first.service.detect(s, tx), null);
  await first.service.execute(s, event, tx, {}, async () => ({ status:1, blockHash:BLOCK }));
  assert.equal(first.submissions(), 1);
  const restarted = fixture({ repository:first.repository });
  assert.equal(await restarted.service.detect(s, tx), null);
  assert.equal(restarted.submissions(), 0);
});

test('a reorg-dropped source is skipped without submitting or being marked copied', async () => {
  const f=fixture(); const s=sniper(); const tx=source(); const event=await f.service.detect(s,tx);
  assert.equal(await f.service.execute(s,event,tx,{},async()=>null),'skipped');
  assert.equal(f.submissions(),0);
  assert.equal(f.repository.events.get(f.repository.key(event)).state,'skipped');
  assert.match(f.repository.transitions.at(-1)[1].skipReason,/reorganization/);
});

test('malformed sniper patches are rejected before mutation', () => {
  const f=fixture(); const current=sniper();
  assert.throws(() => f.service.validatePatch(current,{ targetAddress:'bad' }),ValidationError);
  assert.throws(() => f.service.validatePatch(current,{ maxAttempts:0 }),ValidationError);
  assert.throws(() => f.service.validatePatch(current,{ active:'yes' }),ValidationError);
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
    assert.equal(await f.service.execute(s,event,tx,{},async()=>({status:1,blockHash:BLOCK})),'skipped');
    assert.equal(f.submissions(),0); assert.match(f.repository.transitions.at(-1)[1].skipReason,reason);
  });
  await t.test('max attempts',async()=>{
    const f=fixture(); const s=sniper({maxAttempts:1}); const tx=source(); const event=await f.service.detect(s,tx);
    f.repository.events.get(f.repository.key(event)).attemptCount=1;
    assert.equal(await f.service.execute(s,event,tx,{},async()=>({status:1,blockHash:BLOCK})),'duplicate');
    assert.equal(f.submissions(),0);
  });
});

test('one sniper failure is isolated while another ready sniper continues', async () => {
  const f=fixture(); const first=sniper({id:SNIPER}); const second=sniper({id:'33333333-3333-4333-8333-333333333333'});
  const tx1=source(); const tx2=source({hash:`0x${'56'.repeat(32)}`});
  await f.service.detect(first,tx1); await f.service.detect(second,tx2);
  const results=await f.service.processBlock('ethereum',11,[first,second],async hash=>{
    if(hash===SOURCE)throw new Error('isolated provider decode error'); return tx2;
  },async()=>({status:1,blockHash:BLOCK}),()=>({}));
  assert.equal(results.length,2);
  assert.equal(results[0].status,'rejected');
  assert.equal(results[1].status,'fulfilled');
  assert.equal(f.submissions(),1);
});

test('a submitted copy is reconciled after restart instead of resubmitted', async () => {
  const repository=new MemoryRepository(); const s=sniper(); const tx=source();
  const detected=await repository.detect(s,tx); const submitted=await repository.claim(detected,3);
  submitted.transactionIntentId='intent-existing'; repository.events.get(repository.key(submitted)).transactionIntentId='intent-existing';
  let submissions=0; let reconciliations=0;
  const service=createSniperService({repository,supportedChains:['ethereum'],
    intentRepository:{get:async()=>({intentId:'intent-existing',state:'pending'}),getByIdempotencyKey:async()=>null},
    transactionEngine:{submit:async()=>{submissions+=1;},reconcileIntent:async intent=>{reconciliations+=1;return{...intent,state:'confirmed'};}},
  });
  await service.processBlock('ethereum',11,[s],async()=>tx,async()=>({status:1,blockHash:BLOCK}),()=>({}));
  assert.equal(reconciliations,1);
  assert.equal(submissions,0);
  assert.equal(repository.events.get(repository.key(submitted)).state,'confirmed');
});
