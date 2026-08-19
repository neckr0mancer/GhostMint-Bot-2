/* global setTimeout, clearTimeout */
import React,{useEffect,useMemo,useState} from 'react';
import {Empty,PageTitle,StatusPill} from '../shared.jsx';
import {formatAmount,formatWhen,QuickMintToggle} from './helpers.jsx';

const SUCCESS_STATUSES=new Set(['confirmed','success','executed','enabled','healthy','submitted','resolved','up']);

export function StatusBar({summary,go}){return <div className="dash-statusbar">
  <PageTitle eyebrow="Everything in one view" title="Dashboard" subtitle="A live summary of every tab below - drill into any card for the full picture."/>
  <div className="dash-statusbar-wallet">
    {summary.wallets.length
      ?<div className="dash-wallet-chips">{summary.wallets.map(wallet=><span className="dash-wallet-chip" key={wallet.label}><span className="pill">{wallet.chain}</span><strong>{wallet.label}</strong><span>{wallet.balance??'—'} {wallet.symbol||''}</span></span>)}{summary.walletCount>summary.wallets.length&&<span className="dash-wallet-more">+{summary.walletCount-summary.wallets.length} more</span>}</div>
      :<span>No wallets yet</span>}
    <button className="b g sm" onClick={()=>go('Wallets')}>View wallets</button>
    <span className="dash-bell pulse" aria-label={`${summary.pendingConfirmations.length} pending confirmations`}>&#9889; {summary.pendingConfirmations.length}</span>
  </div>
</div>;}

export function AlertBanner({summary}){if(!summary.lowBalanceWallets.length)return null;return <div className="notice error" role="alert">
  Low balance: {summary.lowBalanceWallets.map(wallet=>wallet.label).join(', ')} - top these up before minting.
</div>;}

export function HeroAction({go}){return <section className="panel dash-hero glow dash-hero-animated">
  <h2>Mint Now</h2>
  <p>Jump straight into the Minting flow with simulation-backed previews.</p>
  <div className="dash-hero-actions">
    <button className="b" onClick={()=>go('Minting')}>Mint now</button>
    <QuickMintToggle go={go}/>
  </div>
</section>;}

let toastCounter=0;
export function PendingQueue({summary,go}){
  const [toasts,setToasts]=useState([]);
  const [burst,setBurst]=useState(null);
  useEffect(()=>{
    function listener(event){
      const message=event.detail;
      if(message?.type!=='confirmation.resolved')return;
      const id=++toastCounter;
      const celebrate=message.decision!=='REJECT';
      setToasts(current=>[...current,{id,text:celebrate?'Confirmation resolved':'Confirmation rejected',celebrate}]);
      if(celebrate)setBurst(id);
      setTimeout(()=>setToasts(current=>current.filter(toast=>toast.id!==id)),4000);
    }
    window.addEventListener('ghostmint-ws',listener);
    return()=>window.removeEventListener('ghostmint-ws',listener);
  },[]);
  useEffect(()=>{if(burst===null)return;const timer=setTimeout(()=>setBurst(null),900);return()=>clearTimeout(timer);},[burst]);
  return <section className="panel glow dash-pending-carousel">
    <h2>Pending queue</h2>
    {summary.pendingConfirmations.length===0
      ?<Empty text="Nothing pending confirmation right now."/>
      :<div className="dash-carousel">{summary.pendingConfirmations.map(item=><div className="dash-carousel-card" key={item.id}>
          <span className="dash-ring" aria-hidden="true"/>
          <strong>{item.triggerSource||'trigger'}</strong>
          <span>{item.targetType}</span>
        </div>)}</div>}
    <button className="b g sm" onClick={()=>go('Activity')}>View activity</button>
    <div className="dash-toast-stack" aria-live="polite">{toasts.map(toast=><div className={`dash-toast${toast.celebrate?' celebrate':''}`} key={toast.id}>{toast.text}{burst===toast.id&&<span className="dash-confetti" aria-hidden="true">{Array.from({length:12}).map((_,index)=><i key={index} style={{'--i':index}}/>)}</span>}</div>)}</div>
  </section>;
}

export function StatsStrip({summary,go}){const streak=useMemo(()=>{let count=0;for(const item of summary.activityItems){if(SUCCESS_STATUSES.has(String(item.status||'').toLowerCase()))count++;else break;}return count;},[summary.activityItems]);
  return <section className="panel glow">
    <h2>Quick stats</h2>
    <div className="dash-stat-grid">
      <div><strong>{summary.totalMinted}</strong><span>Total minted</span></div>
      <div><strong>{summary.successRate===null?'-':`${summary.successRate}%`}</strong><span>Success rate</span></div>
      <div><strong>{streak}&#128293;</strong><span>Current streak</span></div>
      <div><strong>{formatAmount(summary.netPnl)}</strong><span>Net P&amp;L</span></div>
    </div>
    <button className="b g sm" onClick={()=>go('P&L')}>View P&amp;L</button>
  </section>;}

export function TasksSnipersSummary({summary,go}){return <section className="panel glow dash-tile">
  <h2>Tasks &amp; snipers</h2>
  <p>{summary.tasksTotal} active tasks {summary.nextTaskTime?`- next run ${formatWhen(summary.nextTaskTime)}`:''}</p>
  <p>{summary.sniperCount} active snipers</p>
  <div className="br"><button className="b sm" onClick={()=>go('Tasks')}>View tasks</button><button className="b sm" onClick={()=>go('Snipers')}>View snipers</button></div>
</section>;}

export function WatchTargetSummary({summary,go}){return <section className="panel glow dash-tile">
  <h2>Watch rules &amp; target policies</h2>
  <p>{summary.watchRules.active} of {summary.watchRules.total} watch rules enabled</p>
  <p>{summary.targetsTotal} targets under policy management{summary.watchRules.needingAttention?<span className="warning"> - {summary.watchRules.needingAttention} need attention</span>:null}</p>
  <div className="br"><button className="b sm" onClick={()=>go('Watch Rules')}>View watch rules</button><button className="b sm" onClick={()=>go('Target Policies')}>View target policies</button></div>
</section>;}

export function ActivityFeed({summary,go}){return <section className="panel glow dash-activity">
  <h2>Recent activity</h2>
  {summary.activityItems.length===0
    ?<Empty text="No activity recorded yet."/>
    :<div className="feed">{summary.activityItems.map(item=><article className="feed-item" key={item.id}><div><StatusPill status={item.status}/><h2>{item.title}</h2><p>{formatWhen(item.time)}</p></div></article>)}</div>}
  <button className="b g sm" onClick={()=>go('Activity')}>View all activity</button>
</section>;}

export default {StatusBar,AlertBanner,HeroAction,PendingQueue,StatsStrip,TasksSnipersSummary,WatchTargetSummary,ActivityFeed};
