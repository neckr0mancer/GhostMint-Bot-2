const assert=require('node:assert/strict');
const test=require('node:test');
const {createPendingTransactionDispatcher}=require('../src/sniper/pendingTransactionDispatcher');

const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('pending dispatcher fetches hashes with bounded concurrency and suppresses duplicate delivery',async()=>{
  let active=0;let peak=0;const handled=[];const releases=[];
  const provider={getTransaction:async value=>{active+=1;peak=Math.max(peak,active);
    await new Promise(resolve=>releases.push(resolve));active-=1;return{hash:value};}};
  const dispatcher=createPendingTransactionDispatcher({chain:'ethereum',concurrency:2,
    onTransaction:tx=>handled.push(tx.hash)});
  assert.equal(dispatcher.enqueue(hash(1),provider),true);
  assert.equal(dispatcher.enqueue(hash(1),provider),false);
  assert.equal(dispatcher.enqueue(hash(2),provider),true);
  assert.equal(dispatcher.enqueue(hash(3),provider),true);
  await tick();assert.equal(peak,2);
  while(releases.length)releases.shift()();
  await tick();
  while(releases.length)releases.shift()();
  await tick();
  assert.deepEqual(handled.sort(),[hash(1),hash(2),hash(3)].sort());
  assert.equal(dispatcher.health().processed,3);
  dispatcher.stop();
});

test('one failed pending lookup is isolated and later work still runs',async()=>{
  const logs=[];const handled=[];
  const dispatcher=createPendingTransactionDispatcher({chain:'base',retries:0,
    log:value=>logs.push(value),onTransaction:tx=>handled.push(tx.hash)});
  const provider={getTransaction:async value=>{if(value===hash(1))throw new Error('RPC unavailable');return{hash:value};}};
  dispatcher.enqueue(hash(1),provider);dispatcher.enqueue(hash(2),provider);
  await tick();await tick();
  assert.deepEqual(handled,[hash(2)]);
  assert.equal(dispatcher.health().failed,1);
  assert.ok(logs.some(value=>value.includes('RPC unavailable')));
  dispatcher.stop();
});

test('queue cap drops excess work without throwing or growing unbounded',async()=>{
  let release;const provider={getTransaction:()=>new Promise(resolve=>{release=()=>resolve({hash:hash(1)});})};
  const dispatcher=createPendingTransactionDispatcher({chain:'polygon',concurrency:1,maxQueue:1,
    onTransaction:async()=>{}});
  assert.equal(dispatcher.enqueue(hash(1),provider),true);
  await tick();
  assert.equal(dispatcher.enqueue(hash(2),provider),true);
  assert.equal(dispatcher.enqueue(hash(3),provider),false);
  assert.equal(dispatcher.health().dropped,1);
  release();await tick();dispatcher.stop();
});

test('stop prevents an in-flight lookup from starting transaction handling',async()=>{
  let release;let handled=0;
  const provider={getTransaction:()=>new Promise(resolve=>{release=()=>resolve({hash:hash(9)});})};
  const dispatcher=createPendingTransactionDispatcher({chain:'ethereum',concurrency:1,
    onTransaction:async()=>{handled+=1;}});
  dispatcher.enqueue(hash(9),provider);
  await tick();
  dispatcher.stop();
  release();
  await tick();await tick();
  assert.equal(handled,0);
  assert.equal(dispatcher.health().processed,0);
});
