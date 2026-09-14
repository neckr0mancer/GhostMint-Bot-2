import {walletBalanceForChain} from './walletDisplay.mjs';

function bigintOrNull(value){
  if(value===null||value===undefined||value==='')return null;
  try{return BigInt(value);}catch{return null;}
}

export function decimalNativeToWei(value){
  const match=/^(\d+)(?:\.(\d+))?$/.exec(String(value??'').trim());
  if(!match||match[2]?.length>18)return null;
  try{return BigInt(match[1])*10n**18n+BigInt((match[2]||'').padEnd(18,'0')||'0');}
  catch{return null;}
}

// Normalizes both the current preview payload and the older payload still served by a deployment
// during rolling upgrades. Missing values remain unknown: this helper never invents zero gas or a
// zero balance just to fill a row.
export function mintPreviewMetrics({simulation,preview,wallet,chain}={}){
  const nativeValueWei=bigintOrNull(preview?.nativeValueWei);
  let totalDebitWei=bigintOrNull(simulation?.estimatedCostWei);
  let estimatedGasWei=bigintOrNull(simulation?.estimatedGasCostWei);
  if(estimatedGasWei===null&&totalDebitWei!==null&&nativeValueWei!==null&&totalDebitWei>=nativeValueWei){
    estimatedGasWei=totalDebitWei-nativeValueWei;
  }
  if(estimatedGasWei===null){
    const gasLimit=bigintOrNull(simulation?.gasLimit);
    const feePerGas=bigintOrNull(simulation?.feePerGasWei);
    if(gasLimit!==null&&feePerGas!==null)estimatedGasWei=gasLimit*feePerGas;
  }
  if(totalDebitWei===null&&nativeValueWei!==null&&estimatedGasWei!==null){
    totalDebitWei=nativeValueWei+estimatedGasWei;
  }
  let walletBalanceWei=bigintOrNull(simulation?.balanceWei);
  if(walletBalanceWei===null){
    const balance=walletBalanceForChain(wallet,chain)?.balance;
    walletBalanceWei=decimalNativeToWei(balance);
  }
  return {
    nativeValueWei:nativeValueWei?.toString()??null,
    estimatedGasWei:estimatedGasWei?.toString()??null,
    totalDebitWei:totalDebitWei?.toString()??null,
    walletBalanceWei:walletBalanceWei?.toString()??null,
    balanceInsufficient:walletBalanceWei!==null&&totalDebitWei!==null&&walletBalanceWei<totalDebitWei,
  };
}
