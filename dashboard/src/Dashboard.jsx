import React,{useEffect,useMemo} from 'react';
import {api,notify,promptDialog,useLoad} from './shared.jsx';
import {THEME_WIDGETS} from './dashboardWidgets/index.js';

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
    wallets:walletList.slice(0,2),
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
