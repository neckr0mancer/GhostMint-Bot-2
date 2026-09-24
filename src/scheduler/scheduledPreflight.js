const { checkpointTiming } = require('./scheduledPreflightWorker');

function bigintOrNull(value) {
  if (value===null||value===undefined) return null;
  return typeof value==='bigint'?value:BigInt(value);
}

function createScheduledPreflightEvaluator({findWallet,inspectMint,resolveMintValueWei,
  estimateGasWei,getBalance,nativeCurrency=()=> 'ETH'}) {
  return async function evaluate(task,check) {
    const wallet=await findWallet(task);
    if(!wallet)throw new Error('Scheduled wallet was not found');
    const inspection=await inspectMint(task,wallet);
    const scheduleObservation=inspection?.scheduleObservation??null;
    // Only an explicitly definitive signal may terminate a task. Missing metadata or a failed probe
    // is not sold out and must never be upgraded into that conclusion.
    if(inspection?.soldOut===true&&inspection?.soldOutDefinitive===true){
      return {result:'sold_out',reason:'The collection or selected stage is sold out.',
        walletLabel:wallet.label,currency:nativeCurrency(task,wallet),scheduleObservation};
    }
    const mintValueWei=bigintOrNull(await resolveMintValueWei(task,wallet,inspection));
    if(mintValueWei===null){
      return {result:'price_unknown',reason:'The mint price is not available yet.',
        walletLabel:wallet.label,currency:nativeCurrency(task,wallet),scheduleObservation};
    }
    const estimatedGasWei=bigintOrNull(await estimateGasWei(task,wallet,inspection));
    if(estimatedGasWei===null)throw new Error('The estimated network fee is not available');
    const totalDebitWei=mintValueWei+estimatedGasWei;
    const balanceWei=bigintOrNull(await getBalance(task,wallet));
    if(balanceWei===null)throw new Error('The wallet balance is not available');
    const common={walletLabel:wallet.label,currency:nativeCurrency(task,wallet),
      mintValueWei,estimatedGasWei,totalDebitWei,balanceWei,scheduleObservation};
    if(balanceWei<totalDebitWei){
      return {...common,result:'short',shortfallWei:totalDebitWei-balanceWei,
        reason:'The wallet balance is below the current estimated debit.'};
    }
    return {...common,result:'ready',shortfallWei:0n,
      reason:'The wallet covered the current estimated debit.'};
  };
}

function scheduledPreflightDelivery(task,check,result,{formatWei,escape=value=>String(value)}={}) {
  const timing=checkpointTiming(check.checkpoint);
  const name=escape(task.name);
  const wallet=escape(result.walletLabel||task.walletLabel||'wallet');
  const currency=escape(result.currency||'native currency');
  const automatic='The final safety check still runs immediately before anything is sent.';
  const changeAction=result.scheduleChangeAction??null;
  const changeReason=result.scheduleChangeReason||result.reason;
  if(changeAction==='awaiting_approval')return {
    text:`⚠️ <b>${name}</b> changed and is paused. ${escape(changeReason||'Review the exact change before it can continue.')} Open Schedule details to approve it or cancel. Nothing was sent.`,
    event:{type:'task.change-review',taskId:task.id,name:task.name,reason:changeReason,
      checkpoint:check.checkpoint},
  };
  if(changeAction==='auto_rescheduled')return {
    text:`🕒 <b>${name}</b> was safely rescheduled. ${escape(changeReason||'The opening moved within your approved delay limit.')} ${automatic}`,
    event:{type:'task.rescheduled',taskId:task.id,name:task.name,reason:changeReason,
      checkpoint:check.checkpoint},
  };
  if(changeAction==='expired'){
    const expiredReason=String(changeReason||'No decision was received before its safety deadline.')
      .replace(/^REVIEW_EXPIRED:\s*/i,'');
    return {
    text:`❌ <b>${name}</b> expired. ${escape(expiredReason)} Nothing was sent.`,
    event:{type:'task.failed',taskId:task.id,name:task.name,reason:expiredReason,
      failureCode:'REVIEW_EXPIRED',severity:'warning',retryable:false,reschedulable:true},
    };
  }
  const acceptedNote=changeAction==='accepted'
    ?` The schedule also changed within the limits you approved: ${escape(changeReason||'the saved baseline was updated.')}`:'';
  if(result.result==='sold_out')return {
    text:`❌ <b>${name}</b> failed because the collection or selected stage sold out before it could run. Nothing was sent.`,
    event:{type:'task.failed',taskId:task.id,name:task.name,
      reason:'The collection or selected stage sold out before this scheduled mint could run. Nothing was sent.',
      failureCode:'SOLD_OUT',severity:'error',retryable:false,reschedulable:false},
  };
  if(result.result==='short'){
    const short=formatWei(result.shortfallWei);
    return {
      text:`⚠️ <b>${name}</b> starts ${timing}, but <b>${wallet}</b> needs ${escape(short)} ${currency} more. Fund this wallet or use another wallet. Nothing was sent.${acceptedNote}`,
      event:{type:'task.lowBalance',taskId:task.id,name:task.name,walletLabel:result.walletLabel,
        shortByNative:short,currency:result.currency,timing,checkpoint:check.checkpoint,automatic:true},
    };
  }
  if(result.result==='price_unknown')return {
    text:`⚠️ <b>${name}</b> starts ${timing}, but its mint price is not available yet. GhostMint will check again before sending. Nothing was sent.${acceptedNote}`,
    event:{type:'task.preflight',taskId:task.id,name:task.name,result:result.result,
      timing,checkpoint:check.checkpoint},
  };
  if(result.result==='check_failed')return {
    text:`⚠️ GhostMint could not complete the early check for <b>${name}</b>. It will check again before sending. Nothing was sent.${acceptedNote}`,
    event:{type:'task.preflight',taskId:task.id,name:task.name,result:result.result,
      timing,checkpoint:check.checkpoint},
  };
  return {
    text:`⏰ <b>${name}</b> starts ${timing} from <b>${wallet}</b>. The current funds check passed.${acceptedNote} ${automatic}`,
    event:{type:check.checkpoint==='five_minute'?'task.reminder':'task.preflight',
      taskId:task.id,name:task.name,walletLabel:result.walletLabel,result:'ready',timing,
      checkpoint:check.checkpoint,automatic:true},
  };
}

module.exports={createScheduledPreflightEvaluator,scheduledPreflightDelivery};
