const assert=require('node:assert/strict');
const test=require('node:test');
const {createScheduledPreflightEvaluator,scheduledPreflightDelivery}=require('../src/scheduler/scheduledPreflight');
const {createScheduledPreflightWorker}=require('../src/scheduler/scheduledPreflightWorker');

const task={id:'task-1',userId:'user-1',name:'Public mint',walletLabel:'alpha',qty:2};
const check={checkId:'1',checkpoint:'five_minute',claimedBy:'worker-1'};
const wallet={label:'alpha',address:'0x0000000000000000000000000000000000000001'};

function evaluator(overrides={}){
  const calls=[];
  const evaluate=createScheduledPreflightEvaluator({
    findWallet:async()=>wallet,
    inspectMint:async()=>({soldOut:false}),
    resolveMintValueWei:async()=>2n,
    estimateGasWei:async()=>3n,
    getBalance:async()=>10n,
    nativeCurrency:()=> 'ETH',
    ...Object.fromEntries(Object.entries(overrides).map(([key,value])=>[key,async(...args)=>{
      calls.push(key);return typeof value==='function'?value(...args):value;
    }])),
  });
  return {evaluate,calls};
}

test('scheduled preflight records ready and short from exact integer snapshots',async()=>{
  const ready=evaluator();
  assert.deepEqual(await ready.evaluate(task,check),{
    result:'ready',reason:'The wallet covered the current estimated debit.',walletLabel:'alpha',
    currency:'ETH',mintValueWei:2n,estimatedGasWei:3n,totalDebitWei:5n,balanceWei:10n,
    shortfallWei:0n,
  });
  const short=evaluator({getBalance:4n});
  assert.equal((await short.evaluate(task,check)).result,'short');
  assert.equal((await short.evaluate(task,check)).shortfallWei,1n);
});

test('unknown phase price is explicit and never falls back to a false free mint',async()=>{
  let feeReads=0;let balanceReads=0;
  const evaluate=createScheduledPreflightEvaluator({findWallet:async()=>wallet,
    inspectMint:async()=>({soldOut:false}),resolveMintValueWei:async()=>null,
    estimateGasWei:async()=>{feeReads+=1;return 3n;},getBalance:async()=>{balanceReads+=1;return 10n;}});
  const result=await evaluate(task,check);
  assert.equal(result.result,'price_unknown');
  assert.equal(feeReads,0);assert.equal(balanceReads,0);
});

test('only definitive sold-out evidence cancels the readiness path',async()=>{
  let valueReads=0;
  const sold=createScheduledPreflightEvaluator({findWallet:async()=>wallet,
    inspectMint:async()=>({soldOut:true,soldOutDefinitive:true}),
    resolveMintValueWei:async()=>{valueReads+=1;return 0n;},estimateGasWei:async()=>1n,
    getBalance:async()=>1n});
  assert.equal((await sold(task,check)).result,'sold_out');assert.equal(valueReads,0);
  const uncertain=evaluator({inspectMint:{soldOut:true,soldOutDefinitive:false}});
  assert.equal((await uncertain.evaluate(task,check)).result,'ready');
});

test('delivery copy is concise and distinguishes a 30-second low-balance warning',()=>{
  const value=scheduledPreflightDelivery(task,{checkpoint:'thirty_second'},
    {result:'short',walletLabel:'alpha',currency:'ETH',shortfallWei:2n},
    {formatWei:String,escape:String});
  assert.match(value.text,/about 30 seconds/);assert.match(value.text,/needs 2 ETH more/);
  assert.doesNotMatch(value.text,/retry|cheaper gas/i);
  assert.equal(value.event.type,'task.lowBalance');
});

function claim(){return {task,check:{...check,generation:1,targetAt:1_300_000}};}
function workerFixture({evaluate=async()=>({result:'ready'}),deliver=async()=>{},completed=true,
  existingNotification=null}={}){
  const order=[];const notifications=[];
  let outboxClaim=existingNotification;
  const repository={
    sync:async()=>{order.push('sync');},claimDue:async()=>existingNotification?[]:[claim()],
    complete:async(value,result)=>{order.push(`complete:${result.result}`);
      if(completed)outboxClaim={task:value.task,check:{...value.check,state:'completed',
        result:result.result,reason:result.reason??null,mintValueWei:result.mintValueWei??null,
        estimatedGasWei:result.estimatedGasWei??null,totalDebitWei:result.totalDebitWei??null,
        balanceWei:result.balanceWei??null,shortfallWei:result.shortfallWei??null,
        notificationAttempts:1,notificationClaimedBy:'worker-1'}};
      return {completed,cancelled:false,check:{...value.check,state:completed?'completed':'superseded'}};},
    claimNotifications:async()=>{order.push('claim-notifications');return outboxClaim?[outboxClaim]:[];},
    finishNotification:async(value,details)=>{order.push('notification-finish');
      notifications.push({id:value.check.checkId,error:details.error});outboxClaim=null;},
  };
  const worker=createScheduledPreflightWorker({repository,evaluate,
    deliver:async(...args)=>{order.push('deliver');return deliver(...args);},
    workerId:'worker-1',now:()=>1_000_000});
  return {worker,order,notifications};
}

test('a checkpoint result is durable before notification delivery',async()=>{
  const value=workerFixture();await value.worker.tick();
  assert.deepEqual(value.order,['sync','complete:ready','claim-notifications','deliver','notification-finish']);
  assert.equal(value.notifications[0].error,null);
});

test('notification failure cannot roll back or re-run a completed checkpoint',async()=>{
  const value=workerFixture({deliver:async()=>{throw new Error('telegram unavailable');}});
  await value.worker.tick();
  assert.deepEqual(value.order,['sync','complete:ready','claim-notifications','deliver','notification-finish']);
  assert.match(value.notifications[0].error,/telegram unavailable/);
});

test('a committed notification missed during a crash is delivered by the next worker tick',async()=>{
  const value=workerFixture({existingNotification:{task,check:{...check,state:'completed',result:'ready',
    notificationAttempts:1,notificationClaimedBy:'worker-1'}}});
  await value.worker.tick();
  assert.deepEqual(value.order,['sync','claim-notifications','deliver','notification-finish']);
  assert.equal(value.notifications[0].error,null);
});

test('an evaluation failure is persisted as check_failed and a stale generation never delivers',async()=>{
  const failed=workerFixture({evaluate:async()=>{throw new Error('RPC unavailable');}});
  await failed.worker.tick();assert.match(failed.order.join(','),/complete:check_failed/);
  const stale=workerFixture({completed:false});await stale.worker.tick();
  assert.deepEqual(stale.order,['sync','complete:ready','claim-notifications']);
});

test('graceful stop waits for an active checkpoint tick before its database can close',async()=>{
  let releaseSync;let stopped=false;
  const repository={sync:()=>new Promise(resolve=>{releaseSync=resolve;}),claimDue:async()=>[],
    claimNotifications:async()=>[]};
  const worker=createScheduledPreflightWorker({repository,evaluate:async()=>({result:'ready'}),
    deliver:async()=>{},now:()=>1_000_000});
  const ticking=worker.tick();
  const stopping=worker.stop().then(()=>{stopped=true;});
  await Promise.resolve();
  assert.equal(stopped,false);
  releaseSync();
  await Promise.all([ticking,stopping]);
  assert.equal(stopped,true);
});
