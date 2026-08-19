import React,{useEffect,useMemo,useState} from 'react';
import {api,notify,promptDialog,useLoad} from './shared.jsx';
import {THEME_WIDGETS} from './dashboardWidgets/index.js';
import Home from './dashboardWidgets/home.jsx';

const SUCCESS_STATUSES=new Set(['confirmed','success','executed','enabled','healthy','submitted','resolved','up']);
const LOW_BALANCE_THRESHOLD=0.01;
// One page of activity serves three different derivations at three different depths: the feed
// shows 8 rows, the success tile is scoped to the last 20 (contract §5.6), and the streak counts
// back through up to 50 (contract §5.7). Fetching the deepest of the three once and slicing it
// three ways costs one request instead of three and keeps every figure drawn from the same
// snapshot -- three separate fetches could disagree with each other mid-refresh.
const ACTIVITY_PAGE_SIZE=50;
const FEED_ROWS=8;
const SUCCESS_SCOPE=20;

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
  return null;
}

// BRIEF §9.2-O2, the one pre-authorised dashboard-side data fix in this phase.
//
// publicWallet() (src/dashboard/api.js:19) returns {label,address,chain,balances,minted} -- there
// is no `balance` and no `symbol` on a wallet. Every theme's wallet chip read wallet.balance and
// rendered "—" on all five themes, and lowBalanceWallets filtered on the same undefined field, so
// it was permanently empty and the low-balance alert could never fire.
//
// Resolved here rather than in each widget so all four legacy theme packs are fixed by the same
// change: the derived `balance`/`symbol` are written back onto the wallet objects those packs
// already read, so they need no edit at all.
//
// Only ETH is summed. balances[] carries one entry per supported chain and Polygon's symbol is
// MATIC, so a naive sum adds ETH to MATIC (contract §5.3). A null balance is an RPC failure, NOT
// a zero -- counting it as zero would silently under-report a funded wallet, so nulls are counted
// and surfaced instead.
function walletTotals(wallet){
  const balances=Array.isArray(wallet.balances)?wallet.balances:[];
  let eth=null;
  let unavailable=0;
  const other=new Map();
  for(const entry of balances){
    if(entry?.balance===null||entry?.balance===undefined){unavailable+=1;continue;}
    const amount=numeric(entry.balance);
    if(amount===null){unavailable+=1;continue;}
    if(entry.symbol==='ETH')eth=(eth??0)+amount;
    else if(entry.symbol)other.set(entry.symbol,(other.get(entry.symbol)||0)+amount);
  }
  return {eth,unavailable,other};
}

function summarizeWallets(walletList){
  let ethTotal=null;
  let unavailable=0;
  const other=new Map();
  const decorated=walletList.map(wallet=>{
    const totals=walletTotals(wallet);
    unavailable+=totals.unavailable;
    if(totals.eth!==null)ethTotal=(ethTotal??0)+totals.eth;
    for(const [symbol,amount] of totals.other)other.set(symbol,(other.get(symbol)||0)+amount);
    // `balance`/`symbol` are the fields the existing theme widgets already bind to.
    return {...wallet,balance:totals.eth,symbol:totals.eth===null?'':'ETH',ethBalance:totals.eth,chainsUnavailable:totals.unavailable};
  });
  return {decorated,ethTotal,unavailable,other:[...other].map(([symbol,total])=>({symbol,total}))};
}

// Client-side window filter over /api/pnl, which returns everything unfiltered (contract §5.5).
// EXPECT NEGATIVE TOTALS: autoRecordPnl writes sale:0 on every confirmed mint, so every
// auto-created record is a loss until the user edits a sale in by hand. That is the data being
// incomplete, not this derivation being wrong -- do not "correct" the sign.
function bucketPnlByDay(items,windowDays){
  const cutoff=windowDays===null?null:Date.now()-windowDays*24*60*60*1000;
  const inWindow=items.filter(item=>{
    const at=new Date(item.t).getTime();
    return Number.isFinite(at)&&(cutoff===null||at>=cutoff);
  });
  const byDay=new Map();
  for(const item of inWindow){
    const day=new Date(item.t).toISOString().slice(0,10);
    byDay.set(day,(byDay.get(day)||0)+(numeric(item.net)||0));
  }
  const days=[...byDay.entries()].sort((a,b)=>a[0]<b[0]?-1:1)
    .map(([day,net],index)=>({day,net,index}));
  return {days,net:inWindow.reduce((sum,item)=>sum+(numeric(item.net)||0),0),mints:inWindow.length};
}

// Counts back from the newest activity row until the first non-success. Hidden below 2 rather
// than rendered as "1 in a row", which is not a streak (contract §5.7).
function successStreak(items){
  let streak=0;
  for(const item of items){
    if(!SUCCESS_STATUSES.has(String(item.status||'').toLowerCase()))break;
    streak+=1;
  }
  return streak;
}

function summarize({wallets,tasks,snipers,watchRules,activity,pnl,confirmations}){
  const walletList=wallets.data||[];
  const {decorated,ethTotal,unavailable,other}=summarizeWallets(walletList);
  const lowBalanceWallets=decorated.filter(wallet=>wallet.ethBalance!==null&&wallet.ethBalance<LOW_BALANCE_THRESHOLD);
  const taskItems=tasks.data?.items||[];
  // Earliest future mint time among the ones that are actually still coming. Filtering on time
  // ALONE meant pausing or cancelling the next mint left this tile counting down to it anyway --
  // a timer for something that will never fire. The request is scoped to status=pending, and the
  // status is re-checked here because the two can disagree for a moment: a pause arrives over the
  // socket before the refetch lands.
  const now=Date.now();
  const STILL_COMING=new Set(['scheduled','claimed','retry']);
  const upcoming=taskItems
    .filter(task=>task.mintTime&&new Date(task.mintTime).getTime()>now
      &&STILL_COMING.has(String(task.status||'').toLowerCase()))
    .sort((a,b)=>new Date(a.mintTime).getTime()-new Date(b.mintTime).getTime());
  const nextTask=upcoming[0]||null;
  const watchRuleItems=watchRules.data?.items||[];
  const activityItems=activity.data?.items||[];
  const successScope=activityItems.slice(0,SUCCESS_SCOPE);
  const successCount=successScope.filter(item=>SUCCESS_STATUSES.has(String(item.status||'').toLowerCase())).length;
  const pnlItems=pnl.data||[];
  return {
    loading:wallets.data===null||tasks.data===null||snipers.data===null||watchRules.data===null||activity.data===null||pnl.data===null,
    wallets:decorated.slice(0,2),
    walletRows:decorated.slice(0,4),
    walletCount:walletList.length,
    portfolio:{eth:ethTotal,chainsUnavailable:unavailable,other},
    lowBalanceWallets,
    pendingConfirmations:confirmations.data||[],
    tasksTotal:tasks.data?.total??0,
    nextTaskTime:nextTask?.mintTime||null,
    nextTask,
    sniperCount:snipers.data?.items?.length??0,
    watchRules:{active:watchRuleItems.filter(item=>item.enabled).length,needingAttention:watchRuleItems.filter(item=>item.consecutiveFailures).length,total:watchRuleItems.length},
    failingWatchRules:watchRuleItems.filter(item=>item.consecutiveFailures),
    targetsTotal:(snipers.data?.items?.length??0)+watchRuleItems.length,
    activityItems:activityItems.slice(0,FEED_ROWS),
    activityCount:activityItems.length,
    successRate:successScope.length?Math.round(successCount/successScope.length*100):null,
    successCount,
    successScopeSize:successScope.length,
    streak:successStreak(activityItems),
    latestSuccess:activityItems.find(item=>SUCCESS_STATUSES.has(String(item.status||'').toLowerCase()))||null,
    pnlItems,
    totalMinted:decorated.reduce((sum,wallet)=>sum+(Number(wallet.minted)||0),0),
    totalGasSpent:pnlItems.reduce((sum,item)=>sum+(Number(item.gas)||0),0),
    netPnl:pnlItems.reduce((sum,item)=>sum+(Number(item.net)||0),0),
  };
}

export default function Dashboard({profile,go,onProfileChange}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  // status=pending so the five rows this asks for are five CANDIDATES, not five rows that might
  // all be cancelled. Ordered by mint_time, so the next one due is in here unless five pending
  // mints are simultaneously overdue -- a state the worker clears within seconds.
  const tasks=useLoad('/api/tasks?page=1&pageSize=5&status=pending',[],'tasks.changed');
  const snipers=useLoad('/api/snipers',[],'snipers.changed');
  const watchRules=useLoad('/api/watch-rules',[],'watchrules.changed');
  const activity=useLoad(`/api/activity?page=1&pageSize=${ACTIVITY_PAGE_SIZE}`,[],['snipers.changed','tasks.changed','watchrules.changed','wallets.changed']);
  const pnl=useLoad('/api/pnl',[],'pnl.changed');
  const confirmations=useLoad('/api/confirmations',[],['confirmation.pending','confirmation.resolved']);
  // The caller's own effective ceilings, resolved server-side user override -> group -> chain
  // defaults. Carries the ceiling only: `spentTodayWei` is withheld at the route because
  // rollingSpendWei under-counts, so the budget tile shows a real ceiling and no meter rather
  // than a meter built on a wrong denominator.
  const limits=useLoad('/api/profile/limits');
  const sources={wallets,tasks,snipers,watchRules,activity,pnl,confirmations,limits};
  const summary=useMemo(()=>summarize(sources),
    [wallets.data,tasks.data,snipers.data,watchRules.data,activity.data,pnl.data,confirmations.data,limits.data]);
  const [pnlWindow,setPnlWindow]=useState(30);
  const pnlView=useMemo(()=>bucketPnlByDay(summary.pnlItems,pnlWindow),[summary.pnlItems,pnlWindow]);
  const pnl30=useMemo(()=>bucketPnlByDay(summary.pnlItems,30),[summary.pnlItems]);

  const greeting=<DashboardGreeting displayName={profile.displayName} onNamed={name=>onProfileChange?.(current=>({...current,displayName:name}))}/>;

  // The two primary themes get the redesigned Home. The other three keep the legacy widget grid
  // untouched -- they have no redesigned layout and no mobile layout at all (brief §9.1-D15), so
  // routing them through the new markup would give them a layout nobody has verified.
  if(profile.theme==='ghost-mint'||profile.theme==='ghost-mint-light'){
    // The greeting IS the page's h1 in the prototype, so it is passed in rather than rendered
    // as a stray line above the header. Falls back to a plain "Home" before a name is set.
    const greetingText=profile.displayName?`${greetingForHour(new Date().getHours())}, ${profile.displayName}.`:'Home';
    return <>{greeting}<Home summary={summary} sources={sources} go={go} greeting={greetingText}
      pnlView={pnlView} pnl30={pnl30} pnlWindow={pnlWindow} onPnlWindow={setPnlWindow}/></>;
  }

  const widgets=THEME_WIDGETS[profile.theme]||THEME_WIDGETS['ghost-mint'];
  const props={summary,go,profile};
  return <>
    {greeting}
    <widgets.StatusBar {...props}/>
    <widgets.AlertBanner {...props}/>
    <div className="dashboard-grid">
      <widgets.HeroAction {...props}/>
      <widgets.PendingQueue {...props}/>
      <widgets.StatsStrip {...props}/>
      <widgets.TasksSnipersSummary {...props}/>
      <widgets.WatchTargetSummary {...props}/>
      <widgets.ActivityFeed {...props}/>
    </div>
  </>;
}
