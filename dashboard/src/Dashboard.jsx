import React,{useEffect,useMemo,useState} from 'react';
import {api,confirmDialog,notify,promptDialog,useLoad} from './shared.jsx';
import {THEME_WIDGETS} from './dashboardWidgets/index.js';

const ADDRESS_SHAPE=/^0x[0-9a-fA-F]{40}$/;
// A real USD figure of $0 is possible and must render as $0.00, not be dropped -- only a missing
// price feed (null) omits the parenthetical entirely.
function usdSuffix(usd){return usd===null||usd===undefined?'':` (~$${usd.toFixed(2)})`;}

// A condensed version of the full Minting page's auto-detect-and-mint path, for the common single-
// wallet case, right on the page every session starts on -- same /api/mints/detect|preview|confirm
// calls, just without batch wallets, saved presets, or the advanced manual-calldata override, which
// stay exclusive to the full page ("Advanced options" links there for those).
function QuickMint({go}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  const [walletLabel,setWalletLabel]=useState('');
  const [contractAddress,setContractAddress]=useState('');
  const [quantity,setQuantity]=useState('1');
  const [detecting,setDetecting]=useState(false);
  const [detected,setDetected]=useState(null);
  const [preview,setPreview]=useState(null);
  useEffect(()=>{if(!walletLabel&&wallets.data?.length)setWalletLabel(wallets.data[0].label);},[wallets.data]);
  function reset(){setContractAddress('');setQuantity('1');setDetected(null);setPreview(null);}
  async function detect(){
    const trimmed=contractAddress.trim();
    if(!trimmed){notify('Enter a contract address first.',{type:'error'});return;}
    setDetecting(true);
    try{
      const result=await api(`/api/mints/detect?contractAddress=${encodeURIComponent(trimmed)}&quantity=${encodeURIComponent(quantity)}`);
      setDetected(result);
      const label=result.isSeaDrop?'SeaDrop drop':'contract';
      notify(result.priceKnown?`Detected ${label} on ${result.chain} — price read from the contract.`:`Detected ${label} on ${result.chain}, but the price couldn't be read.`,{type:result.priceKnown?'success':'info'});
    }catch(value){notify(value.message,{type:'error'});setDetected(null);}
    finally{setDetecting(false);}
  }
  function handleContractBlur(){if(ADDRESS_SHAPE.test(contractAddress.trim()))detect();}
  async function submit(event){
    event.preventDefault();
    if(!detected){notify('Detect the contract first.',{type:'error'});return;}
    // Unlike the full Minting page, this widget has no manual-value override -- proceeding with an
    // unknown price would silently submit valueWei:'0', which could treat a paid mint as free.
    // Send unknown-price contracts to the full page instead of guessing.
    if(!detected.priceKnown){go('Minting');return;}
    try{
      const input={walletLabel,contractAddress:contractAddress.trim(),methodSignature:detected.methodSignature,
        seaDropAddress:detected.seaDropAddress||undefined,arguments:detected.arguments,valueWei:detected.valueWei||'0'};
      setPreview(await api('/api/mints/preview',{method:'POST',body:JSON.stringify(input)}));
    }catch(value){notify(value.message,{type:'error'});}
  }
  async function confirmMint(){
    if(!await confirmDialog('Broadcast this simulation-backed mint?'))return;
    try{
      await api('/api/mints/confirm',{method:'POST',body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});
      notify('Mint submitted.',{type:'success'});
      reset();
    }catch(value){notify(value.message,{type:'error'});}
  }
  return <section className="panel quick-mint">
    <h2>Quick mint</h2>
    <form onSubmit={submit}>
      <div className="field-row">
        <label>Wallet<select value={walletLabel} onChange={e=>setWalletLabel(e.target.value)} required>
          {wallets.data?.map(w=><option key={w.label} value={w.label}>{w.label}</option>)}
        </select></label>
        <label>Quantity<input type="number" min="1" max="100" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
      </div>
      <label>Contract address<input value={contractAddress} placeholder="0x…"
        onChange={e=>{setContractAddress(e.target.value);setDetected(null);}} onBlur={handleContractBlur}/></label>
      <div className="field-row">
        <button type="button" className="quiet" onClick={detect} disabled={detecting}>{detecting?'Detecting…':'Detect'}</button>
        <button type="submit" disabled={!detected}>{detected&&!detected.priceKnown?'Open full page to set price':'Preview mint'}</button>
      </div>
      {detected&&<p className="mint-detected-summary">Detected on {detected.chain}: <code>{detected.methodSignature}</code>
        {detected.priceKnown?` · ${detected.valueWei==='0'?'free':detected.valueWei+' wei'}`:' · price not exposed by this contract -- enter it manually on the full page'}
        {detected.soldOut
          ?(detected.displayPrice?` · Sold out — floor ${detected.displayPrice.eth} ETH${usdSuffix(detected.displayPrice.usd)}`:' · Sold out — floor price unavailable')
          :(detected.displayPrice?usdSuffix(detected.displayPrice.usd):'')}</p>}
    </form>
    {preview&&<div className="preview">
      <p>Estimated total: {preview.items[0].simulation.estimatedCostWei} wei | Gas: {preview.items[0].simulation.gasLimit}</p>
      <button className="quiet" onClick={confirmMint}>Confirm and broadcast</button>
    </div>}
    <button type="button" className="quiet panel-cta" onClick={()=>go('Minting')}>Advanced options →</button>
  </section>;
}

const SUCCESS_STATUSES=new Set(['confirmed','success','executed','enabled','healthy','submitted','resolved','up']);
const LOW_BALANCE_THRESHOLD=0.01;

function numeric(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}

function greetingForHour(hour){
  if(hour<5)return 'Good night';
  if(hour<12)return 'Good morning';
  if(hour<18)return 'Good afternoon';
  return 'Good evening';
}

// Every user without a saved display name gets prompted once per dashboard visit -- new accounts
// and pre-existing ones that never set one look identical here (both have displayName===null).
function DashboardGreeting({displayName,onNamed}){
  useEffect(()=>{
    if(displayName)return;
    let cancelled=false;
    (async()=>{
      const value=await promptDialog('What should we call you?',{placeholder:'Your name'});
      const trimmed=value?.trim();
      if(cancelled||!trimmed)return;
      try{
        const result=await api('/api/profile/display-name',{method:'PUT',body:JSON.stringify({displayName:trimmed})});
        onNamed(result.displayName);
      }catch{/* leave it unset -- the prompt will just ask again next visit */}
    })();
    return()=>{cancelled=true;};
  },[displayName]);
  if(!displayName)return null;
  return <p className="dashboard-greeting">{greetingForHour(new Date().getHours())}, {displayName}.</p>;
}

function summarize({wallets,tasks,snipers,watchRules,activity,pnl,confirmations}){
  const walletList=wallets.data||[];
  const lowBalanceWallets=walletList.filter(wallet=>{const balance=numeric(wallet.balance);return balance!==null&&balance<LOW_BALANCE_THRESHOLD;});
  const taskItems=tasks.data?.items||[];
  const nextTaskTime=taskItems.map(task=>task.mintTime).filter(Boolean).sort()[0]||null;
  const watchRuleItems=watchRules.data?.items||[];
  const activityItems=activity.data?.items||[];
  const successCount=activityItems.filter(item=>SUCCESS_STATUSES.has(String(item.status||'').toLowerCase())).length;
  const pnlItems=pnl.data||[];
  return {
    loading:wallets.data===null||tasks.data===null||snipers.data===null||watchRules.data===null||activity.data===null||pnl.data===null,
    wallet:walletList[0]||null,
    walletCount:walletList.length,
    lowBalanceWallets,
    pendingConfirmations:confirmations.data||[],
    tasksTotal:tasks.data?.total??0,
    nextTaskTime,
    sniperCount:snipers.data?.items?.length??0,
    watchRules:{active:watchRuleItems.filter(item=>item.enabled).length,needingAttention:watchRuleItems.filter(item=>item.consecutiveFailures).length,total:watchRuleItems.length},
    targetsTotal:(snipers.data?.items?.length??0)+watchRuleItems.length,
    activityItems:activityItems.slice(0,8),
    successRate:activityItems.length?Math.round(successCount/activityItems.length*100):null,
    totalMinted:walletList.reduce((sum,wallet)=>sum+(Number(wallet.minted)||0),0),
    totalGasSpent:pnlItems.reduce((sum,item)=>sum+(Number(item.gas)||0),0),
    netPnl:pnlItems.reduce((sum,item)=>sum+(Number(item.net)||0),0),
  };
}

export default function Dashboard({profile,go,onProfileChange}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  const tasks=useLoad('/api/tasks?page=1&pageSize=5',[],'tasks.changed');
  const snipers=useLoad('/api/snipers',[],'snipers.changed');
  const watchRules=useLoad('/api/watch-rules',[],'watchrules.changed');
  const activity=useLoad('/api/activity?page=1&pageSize=8',[],['snipers.changed','tasks.changed','watchrules.changed','wallets.changed']);
  const pnl=useLoad('/api/pnl',[],'pnl.changed');
  const confirmations=useLoad('/api/confirmations',[],['confirmation.pending','confirmation.resolved']);
  const summary=useMemo(()=>summarize({wallets,tasks,snipers,watchRules,activity,pnl,confirmations}),
    [wallets.data,tasks.data,snipers.data,watchRules.data,activity.data,pnl.data,confirmations.data]);
  const widgets=THEME_WIDGETS[profile.theme]||THEME_WIDGETS['ghost-mint'];
  const props={summary,go,profile};
  const isSplitColumns=profile.theme==='ghost-mint'||profile.theme==='ghost-mint-light';
  return <>
    <DashboardGreeting displayName={profile.displayName} onNamed={name=>onProfileChange?.(current=>({...current,displayName:name}))}/>
    <QuickMint go={go}/>
    <widgets.StatusBar {...props}/>
    <widgets.AlertBanner {...props}/>
    {isSplitColumns?<div className="dashboard-grid dashboard-grid-split">
      <div className="dashboard-col">
        <widgets.HeroAction {...props}/>
        <widgets.PendingQueue {...props}/>
        <widgets.ActivityFeed {...props}/>
      </div>
      <div className="dashboard-col">
        <widgets.StatsStrip {...props}/>
        <widgets.TasksSnipersSummary {...props}/>
        <widgets.WatchTargetSummary {...props}/>
      </div>
    </div>:<div className="dashboard-grid">
      <widgets.HeroAction {...props}/>
      <widgets.PendingQueue {...props}/>
      <widgets.StatsStrip {...props}/>
      <widgets.TasksSnipersSummary {...props}/>
      <widgets.WatchTargetSummary {...props}/>
      <widgets.ActivityFeed {...props}/>
    </div>}
  </>;
}
