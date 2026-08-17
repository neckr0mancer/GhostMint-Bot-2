import React from 'react';
import {Empty,PageTitle,StatusPill} from '../shared.jsx';
import {formatAmount,formatWhen,QuickMintToggle} from './helpers.jsx';

export function StatusBar({summary,go}){return <div className="dash-statusbar">
  <PageTitle eyebrow="Everything in one view" title="Dashboard" subtitle="A live summary of every tab below - drill into any card for the full picture."/>
  <div className="dash-statusbar-wallet">
    {summary.wallets.length
      ?<div className="dash-wallet-chips">{summary.wallets.map(wallet=><span className="dash-wallet-chip" key={wallet.label}><span className="pill">{wallet.chain}</span><strong>{wallet.label}</strong><span>{wallet.balance??'—'} {wallet.symbol||''}</span></span>)}{summary.walletCount>summary.wallets.length&&<span className="dash-wallet-more">+{summary.walletCount-summary.wallets.length} more</span>}</div>
      :<span>No wallets yet</span>}
    <button className="quiet small" onClick={()=>go('Wallets')}>View wallets</button>
    <span className="dash-bell" aria-label={`${summary.pendingConfirmations.length} pending confirmations`}>&#128276; {summary.pendingConfirmations.length}</span>
  </div>
</div>;}

export function AlertBanner({summary}){if(!summary.lowBalanceWallets.length)return null;return <div className="notice error" role="alert">
  Low balance: {summary.lowBalanceWallets.map(wallet=>wallet.label).join(', ')} - top these up before minting.
</div>;}

export function HeroAction({go}){return <section className="panel dash-hero glow">
  <h2>Mint Now</h2>
  <p>Jump straight into the Minting flow with simulation-backed previews.</p>
  <div className="dash-hero-actions">
    <button onClick={()=>go('Minting')}>Mint now</button>
    <QuickMintToggle go={go}/>
  </div>
</section>;}

const TRIGGER_LABELS={'blockchain-triggered':'sniper','social-triggered':'social'};
function triggerChipClass(triggerSource){return triggerSource==='social-triggered'?'dash-chip-social':'dash-chip-sniper';}
export function PendingQueue({summary,go}){return <section className="panel glow dash-pending">
  <h2>Pending queue</h2>
  {summary.pendingConfirmations.length===0
    ?<Empty text="Nothing pending confirmation right now."/>
    :<div className="dash-chip-row">{summary.pendingConfirmations.map(item=><span className={`dash-chip pulse ${triggerChipClass(item.triggerSource)}`} key={item.id}>{TRIGGER_LABELS[item.triggerSource]||item.triggerSource||'trigger'}: {item.targetType}</span>)}</div>}
  <button className="quiet small panel-cta" onClick={()=>go('Activity')}>View activity</button>
</section>;}

export function StatsStrip({summary,go}){return <section className="panel glow dash-stats">
  <h2>Quick stats</h2>
  <div className="dash-stat-grid dash-stat-grid-2col">
    <div><strong>{summary.totalMinted}</strong><span>Total minted</span></div>
    <div><strong className="stat-accent">{summary.successRate===null?'-':`${summary.successRate}%`}</strong><span>Recent success rate</span></div>
    <div><strong>{formatAmount(summary.totalGasSpent)}</strong><span>Gas spent</span></div>
    <div><strong className="stat-accent-2">{formatAmount(summary.netPnl)}</strong><span>Net P&amp;L</span></div>
  </div>
  <button className="quiet small panel-cta" onClick={()=>go('P&L')}>View P&amp;L</button>
</section>;}

export function TasksSnipersSummary({summary,go}){return <section className="panel glow dash-tasks-snipers">
  <h2>Tasks &amp; snipers</h2>
  <p>{summary.tasksTotal} active tasks {summary.nextTaskTime?`- next run ${formatWhen(summary.nextTaskTime)}`:''}</p>
  <p>{summary.sniperCount} active snipers</p>
  <div className="actions panel-cta"><button className="small" onClick={()=>go('Tasks')}>View tasks</button><button className="small" onClick={()=>go('Snipers')}>View snipers</button></div>
</section>;}

export function WatchTargetSummary({summary,go}){return <section className="panel glow dash-watch-target">
  <h2>Watch rules &amp; target policies</h2>
  <p>{summary.watchRules.active} of {summary.watchRules.total} watch rules enabled</p>
  <p>{summary.targetsTotal} targets under policy management{summary.watchRules.needingAttention?<span className="warning"> - {summary.watchRules.needingAttention} need attention</span>:null}</p>
  <div className="actions panel-cta"><button className="small" onClick={()=>go('Watch Rules')}>View watch rules</button><button className="small" onClick={()=>go('Target Policies')}>View target policies</button></div>
</section>;}

export function ActivityFeed({summary,go}){return <section className="panel glow dash-activity">
  <h2>Recent activity</h2>
  {summary.activityItems.length===0
    ?<Empty text="No activity recorded yet."/>
    :<div className="feed">{summary.activityItems.map(item=><article className="feed-item" key={item.id}><div><StatusPill status={item.status}/><h2>{item.title}</h2><p>{formatWhen(item.time)}</p></div></article>)}</div>}
  <button className="quiet small panel-cta" onClick={()=>go('Activity')}>View all activity</button>
</section>;}

export default {StatusBar,AlertBanner,HeroAction,PendingQueue,StatsStrip,TasksSnipersSummary,WatchTargetSummary,ActivityFeed};
