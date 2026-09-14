const { randomUUID } = require('node:crypto');

const FIVE_MINUTE_LEAD_MS=5*60*1000;
const THIRTY_SECOND_LEAD_MS=30*1000;

function checkpointTiming(checkpoint) {
  return checkpoint==='five_minute'?'in about 5 minutes':'in about 30 seconds';
}

function createScheduledPreflightWorker({
  repository,evaluate,deliver,onCommitted=()=>{},now=()=>Date.now(),
  workerId=randomUUID(),leaseMs=90_000,pollIntervalMs=15_000,claimLimit=20,
  notificationLeaseMs=90_000,notificationLimit=20,notificationMaxAttempts=5,
  notificationRetryMs=attempt=>Math.min(5*60_000,15_000*(2**Math.max(0,attempt-1))),
  sanitizeError=error=>String(error?.message||error||'readiness check failed').slice(0,500),
  log=()=>{},
}) {
  let timer=null;
  let running=false;
  let activeTick=null;
  let lastTickAt=null;
  let lastSuccessAt=null;
  let lastError=null;

  async function processClaim(claim) {
    let result;
    try {
      result=await evaluate(claim.task,claim.check);
      if (!result||!['ready','short','price_unknown','sold_out','check_failed'].includes(result.result)) {
        throw new Error('Scheduled preflight returned an invalid result');
      }
    } catch(error) {
      result={result:'check_failed',reason:sanitizeError(error)};
    }
    const persisted=await repository.complete(claim,result);
    if (!persisted.completed) return 'superseded';
    try { await Promise.resolve(onCommitted(claim.task,claim.check,result,persisted)); }
    catch(error) { log(`Scheduled preflight commit hook failed for ${claim.task.id}: ${sanitizeError(error)}`); }
    return result.result;
  }

  async function processNotification(claim) {
    let deliveryError=null;
    const result={result:claim.check.result,reason:claim.check.reason,
      walletLabel:claim.task.walletLabel,mintValueWei:claim.check.mintValueWei,
      estimatedGasWei:claim.check.estimatedGasWei,totalDebitWei:claim.check.totalDebitWei,
      balanceWei:claim.check.balanceWei,shortfallWei:claim.check.shortfallWei};
    try { await deliver(claim.task,claim.check,result,{check:claim.check}); }
    catch(error) {
      deliveryError=sanitizeError(error);
      log(`Scheduled preflight notification failed for ${claim.task.id}: ${deliveryError}`);
    }
    const retryAt=now()+notificationRetryMs(claim.check.notificationAttempts);
    await repository.finishNotification(claim,{error:deliveryError,now:now(),retryAt,
      maxAttempts:notificationMaxAttempts});
    return deliveryError?'retry':'delivered';
  }

  function tick() {
    if (activeTick) return Promise.resolve('busy');
    running=true;lastTickAt=now();
    activeTick=(async()=>{
      try {
        await repository.sync(lastTickAt);
        const claims=await repository.claimDue({workerId,now:lastTickAt,leaseMs,limit:claimLimit});
        await Promise.all(claims.map(claim=>processClaim(claim)
          .catch(error=>log(`Scheduled preflight failed for ${claim.task.id}: ${sanitizeError(error)}`))));
        const notifications=await repository.claimNotifications({workerId,now:now(),
          leaseMs:notificationLeaseMs,limit:notificationLimit});
        await Promise.all(notifications.map(claim=>processNotification(claim)
          .catch(error=>log(`Scheduled preflight notification audit failed for ${claim.task.id}: ${sanitizeError(error)}`))));
        lastSuccessAt=now();lastError=null;
        return claims.length;
      } catch(error) {
        lastError=sanitizeError(error);
        throw error;
      }
    })().finally(()=>{running=false;activeTick=null;});
    return activeTick;
  }

  function start() {
    if (timer) return;
    // Run once at startup so a checkpoint whose due time passed during a deploy is recovered now,
    // not after another full polling interval.
    tick().catch(error=>log(`Scheduled preflight startup failed: ${sanitizeError(error)}`));
    timer=setInterval(()=>tick().catch(error=>log(`Scheduled preflight sweep failed: ${sanitizeError(error)}`)),pollIntervalMs);
    timer.unref?.();
  }
  async function stop() {
    if(timer)clearInterval(timer);timer=null;
    const pending=activeTick;
    if(pending)await pending.catch(()=>{});
  }
  function health(){return {status:timer&&(!lastError||lastSuccessAt>=lastTickAt)?'up':'down',
    running:Boolean(timer),active:running,lastTickAt,lastSuccessAt,lastError};}

  return {health,processClaim,processNotification,start,stop,tick,workerId};
}

module.exports={FIVE_MINUTE_LEAD_MS,THIRTY_SECOND_LEAD_MS,checkpointTiming,
  createScheduledPreflightWorker};
