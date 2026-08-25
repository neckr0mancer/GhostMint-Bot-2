const FINAL_SUCCESS_STATUSES=new Set(['success','confirmed']);
const FINAL_FAILURE_STATUSES=new Set(['fail','failed','failure','reverted']);
const DEFAULT_SCOPE_SIZE=20;

function statusOf(item){
  return String(item?.status||'').trim().toLowerCase();
}

function hasTransactionHash(item){
  return typeof item?.txHash==='string'&&item.txHash.trim().length>0;
}

function normalizedScopeSize(value){
  const parsed=Number(value);
  return Number.isInteger(parsed)&&parsed>0?parsed:DEFAULT_SCOPE_SIZE;
}

export function isFinalBroadcastOutcome(item){
  if(!hasTransactionHash(item))return false;
  const status=statusOf(item);
  return FINAL_SUCCESS_STATUSES.has(status)||FINAL_FAILURE_STATUSES.has(status);
}

export function finalBroadcastOutcomes(items,scopeSize=DEFAULT_SCOPE_SIZE){
  const source=Array.isArray(items)?items:[];
  // Activity is already newest-first. Filter before slicing so safely-blocked previews,
  // scheduler expiries and unrelated health rows cannot crowd real chain outcomes out
  // of the "last 20" window.
  return source.filter(isFinalBroadcastOutcome).slice(0,normalizedScopeSize(scopeSize));
}

export function broadcastOutcomeSummary(items,scopeSize=DEFAULT_SCOPE_SIZE){
  const outcomes=finalBroadcastOutcomes(items,scopeSize);
  const successCount=outcomes.filter(item=>FINAL_SUCCESS_STATUSES.has(statusOf(item))).length;
  return {
    successRate:outcomes.length?Math.round(successCount/outcomes.length*100):null,
    successCount,
    successScopeSize:outcomes.length,
  };
}

export function broadcastSuccessStreak(items){
  const outcomes=(Array.isArray(items)?items:[]).filter(isFinalBroadcastOutcome);
  let streak=0;
  for(const item of outcomes){
    if(!FINAL_SUCCESS_STATUSES.has(statusOf(item)))break;
    streak+=1;
  }
  return streak;
}

export function latestConfirmedMint(items){
  const source=Array.isArray(items)?items:[];
  return source.find(item=>hasTransactionHash(item)
    &&FINAL_SUCCESS_STATUSES.has(statusOf(item))
    &&/mint/i.test(String(item?.title||'')))||null;
}
