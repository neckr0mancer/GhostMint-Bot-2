function normalizedChain(value){return String(value||'').trim().toLowerCase();}

export function walletBalanceForChain(wallet,chain){
  const wanted=normalizedChain(chain);
  if(!wanted)return null;
  return (wallet?.balances||[]).find(item=>normalizedChain(item?.chain)===wanted)||null;
}

// A wallet address works across every supported EVM chain. Prefer the account's current default
// network when it has funds, then the wallet's stored nominal home, then any funded network. This
// prevents a legacy `ethereum` home value of zero from hiding a real Robinhood balance.
export function selectWalletHeadlineBalance(wallet,preferredChain){
  const balances=wallet?.balances||[];
  const preferred=walletBalanceForChain(wallet,preferredChain);
  if(preferred&&Number(preferred.balance)>0)return preferred;
  const saved=walletBalanceForChain(wallet,wallet?.chain);
  if(saved&&Number(saved.balance)>0)return saved;
  return balances.find(item=>item?.balance!==null&&item?.balance!==undefined&&Number(item.balance)>0)
    ||preferred||saved||balances[0]||null;
}

export function walletFundingStatus(wallet,{preferredChain,lowThreshold=0.01}={}){
  const row=selectWalletHeadlineBalance(wallet,preferredChain);
  if(row?.balance===null||row?.balance===undefined||row?.balance===''){
    return {label:'Unavailable',tone:'',row};
  }
  return Number(row.balance)>=Number(lowThreshold)
    ?{label:'Funded',tone:'ok',row}:{label:'Low',tone:'wn',row};
}
