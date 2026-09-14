import {mintPreviewMetrics} from './mintPreviewMetrics.mjs';

const NATIVE_SYMBOLS=Object.freeze({
  ethereum:'ETH',base:'ETH',arbitrum:'ETH',polygon:'MATIC',robinhood:'ETH',ink:'ETH',hyperevm:'HYPE',
});

const CONTRACT_FAILURE_CODES=new Set(['MINT_SOLD_OUT','STAGE_SUPPLY_EXHAUSTED','STAGE_NOT_OPEN']);
const WALLET_FAILURE_CODES=new Set(['INSUFFICIENT_BALANCE','WALLET_MINT_LIMIT_REACHED','WALLET_NOT_ELIGIBLE',
  'DAILY_BUDGET_EXCEEDED','VALUE_CEILING_EXCEEDED','GAS_CEILING_EXCEEDED','GAS_TOLERANCE_EXCEEDED']);
const SYSTEM_FAILURE_CODES=new Set(['FEE_UNAVAILABLE','WRONG_CHAIN']);

function bigintOrNull(value){
  if(value===null||value===undefined||value==='')return null;
  try{return BigInt(value);}catch{return null;}
}

function aggregateWei(rows,key){
  let known=0n;
  let knownCount=0;
  let unknownCount=0;
  for(const row of rows){
    const value=bigintOrNull(row.metrics?.[key]);
    if(value===null){unknownCount+=1;continue;}
    known+=value;
    knownCount+=1;
  }
  // An empty set is not a known zero-cost transaction set. In particular, when every selected
  // wallet is blocked there is no ready mint whose value/gas/debit can honestly be totalled.
  if(!rows.length)return {wei:null,knownWei:null,complete:false,knownCount:0,unknownCount:0};
  return {
    wei:unknownCount===0&&knownCount>0?known.toString():null,
    knownWei:knownCount>0?known.toString():null,
    complete:unknownCount===0&&knownCount===rows.length,
    knownCount,
    unknownCount,
  };
}

function walletLabel(value){return value?.wallet?.label||value?.walletLabel||value?.label||'';}
function normalizedChain(value){return String(value||'').trim().toLowerCase();}

export function nativeSymbolForChain(value){
  return NATIVE_SYMBOLS[normalizedChain(value)]||'native';
}

function isUnderfunded(failure,metrics){
  if(metrics.balanceInsufficient)return true;
  if(String(failure?.code||'').toUpperCase()==='INSUFFICIENT_BALANCE')return true;
  return /(?:cannot cover|insufficient funds|balance is below|not enough (?:balance|funds|[A-Z]+))/i
    .test(String(failure?.error||failure?.message||''));
}

// A repeated message is not enough to call a failure a shared mint cause: several wallets can
// independently have the same low balance or eligibility result. Only explicit contract/stage/
// system codes and unmistakable wrong-payment wording receive that stronger classification.
function failureScope(failure,friendlyReason){
  const code=String(failure?.code||'').trim().toUpperCase();
  if(WALLET_FAILURE_CODES.has(code))return 'wallet';
  if(CONTRACT_FAILURE_CODES.has(code))return 'mint';
  if(SYSTEM_FAILURE_CODES.has(code))return 'system';
  const raw=String(failure?.error||failure?.message||'');
  const friendly=String(friendlyReason||'');
  if(/incorrect payment|wrong price|requires exactly/i.test(raw)||/mint price is incorrect/i.test(friendly))return 'mint';
  return 'unknown';
}

function commonIssueForGroup(group){
  if(group.rows.length<2||group.rows.some(row=>row.status==='ready'))return null;
  const first=group.rows[0];
  if(!first.reason)return null;
  const fingerprint=`${first.failureScope}:${String(first.code||'').toUpperCase()}:${first.reason.trim().toLowerCase()}`;
  const shared=group.rows.every(row=>`${row.failureScope}:${String(row.code||'').toUpperCase()}:${String(row.reason||'').trim().toLowerCase()}`===fingerprint);
  // Unknown-but-identical results are collapsed only as repeated presentation copy. They never
  // become `sharedIssue`, so the UI cannot mislabel an unproven failure as a contract problem.
  return shared?{scope:first.failureScope,reason:first.reason,count:group.rows.length,code:first.code||null,groupKey:group.key}:null;
}

function buildRow({value,status,walletsByLabel,detectedChain,fallbackPreview,failureReason}){
  const label=walletLabel(value);
  const wallet=walletsByLabel.get(label)||value?.wallet||null;
  const chain=normalizedChain(value?.chain||detectedChain||wallet?.chain);
  const preview=value?.preview||fallbackPreview||{};
  const simulation=status==='ready'?value?.simulation:value?.details;
  const metrics=mintPreviewMetrics({simulation,preview,wallet,chain});
  const underfunded=status==='blocked'&&isUnderfunded(value,metrics);
  const reason=status==='blocked'?failureReason(value):null;
  return {
    label,
    chain,
    symbol:nativeSymbolForChain(chain),
    methodSignature:String(preview?.methodSignature||''),
    status,
    funding:underfunded?'underfunded'
      :metrics.walletBalanceWei!==null&&metrics.totalDebitWei!==null?'sufficient':'unknown',
    metrics,
    reason,
    code:status==='blocked'?value?.code||null:null,
    failureScope:status==='blocked'?failureScope(value,reason):null,
  };
}

// Builds a presentation-only model. Every wei operation stays in BigInt, chains remain separate
// even when they share a native symbol, and an incomplete aggregate is never presented as a total.
export function mintBatchPreviewModel({preview,wallets=[],selectedLabels=[],detectedChain='',
  fallbackPreview={},failureReason=value=>String(value?.error||'Preview result unavailable.')}={}){
  const walletsByLabel=new Map(wallets.map(wallet=>[wallet.label,wallet]));
  const rows=[
    ...(preview?.items||[]).map(value=>buildRow({value,status:'ready',walletsByLabel,detectedChain,fallbackPreview,failureReason})),
    ...(preview?.failures||[]).map(value=>buildRow({value,status:'blocked',walletsByLabel,detectedChain,fallbackPreview,failureReason})),
  ];
  const rowsByLabel=new Map(rows.map(row=>[row.label,row]));
  const ordered=[];
  for(const label of selectedLabels){
    const row=rowsByLabel.get(label);
    if(row){ordered.push(row);rowsByLabel.delete(label);continue;}
    ordered.push(buildRow({value:{walletLabel:label,error:'Preview result unavailable.'},status:'blocked',
      walletsByLabel,detectedChain,fallbackPreview,failureReason}));
  }
  for(const row of rows){if(rowsByLabel.has(row.label)){ordered.push(row);rowsByLabel.delete(row.label);}}

  const grouped=new Map();
  for(const row of ordered){
    const key=`${row.chain||'unknown'}:${row.symbol}`;
    if(!grouped.has(key))grouped.set(key,{key,chain:row.chain,symbol:row.symbol,rows:[]});
    grouped.get(key).rows.push(row);
  }
  const groups=[...grouped.values()].map(group=>{
    const readyRows=group.rows.filter(row=>row.status==='ready');
    const result={...group,
      selectedCount:group.rows.length,
      readyCount:readyRows.length,
      blockedCount:group.rows.length-readyRows.length,
      underfundedCount:group.rows.filter(row=>row.funding==='underfunded').length,
      combinedBalance:aggregateWei(group.rows,'walletBalanceWei'),
      readyMintValue:aggregateWei(readyRows,'nativeValueWei'),
      readyEstimatedGas:aggregateWei(readyRows,'estimatedGasWei'),
      readyEstimatedDebit:aggregateWei(readyRows,'totalDebitWei'),
    };
    const commonIssue=commonIssueForGroup(result);
    return {...result,commonIssue,sharedIssue:commonIssue&&['mint','system'].includes(commonIssue.scope)?commonIssue:null};
  });
  const readyCount=ordered.filter(row=>row.status==='ready').length;
  const underfundedCount=ordered.filter(row=>row.funding==='underfunded').length;
  return {
    selectedCount:ordered.length,
    readyCount,
    blockedCount:ordered.length-readyCount,
    underfundedCount,
    hasUnderfundedWallet:underfundedCount>0,
    canConfirm:readyCount>0,
    rows:ordered,
    groups,
    commonIssue:groups.length===1?groups[0].commonIssue:null,
    sharedIssue:groups.length===1?groups[0].sharedIssue:null,
  };
}
