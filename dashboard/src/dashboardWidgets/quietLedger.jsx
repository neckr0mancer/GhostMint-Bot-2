import React,{useState} from 'react';
import {Empty,PageTitle,StatusPill} from '../shared.jsx';
import {formatAmount,formatWhen,QuickMintToggle} from './helpers.jsx';

function AdvancedRow({summaryLine,details}){const [open,setOpen]=useState(false);return <div className="dash-plain-row">
  <p>{summaryLine}</p>
  {details&&<>
    <button type="button" className="quiet small" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'Hide advanced details':'Advanced details'}</button>
    {open&&<div className="dash-advanced">{details}</div>}
  </>}
</div>;}

export function StatusBar({summary,go}){return <div className="dash-statusbar dash-quiet">
  <PageTitle eyebrow="Everything in one view" title="Dashboard" subtitle="A summary of every tab below. Open any section for the full picture."/>
  <div className="dash-statusbar-wallet">
    {summary.wallet
      ?<p>Wallet <strong>{summary.wallet.label}</strong> on {summary.wallet.chain}: {summary.wallet.balance??'balance unavailable'} {summary.wallet.symbol||''}</p>
      :<p>No wallets yet.</p>}
    <button className="quiet" onClick={()=>go('Wallets')}>View wallets</button>
    <p>{summary.pendingConfirmations.length} confirmations waiting for you</p>
  </div>
</div>;}

export function AlertBanner({summary}){if(!summary.lowBalanceWallets.length)return null;return <div className="notice error" role="alert">
  Low balance on: {summary.lowBalanceWallets.map(wallet=>wallet.label).join(', ')}. Add funds before minting.
</div>;}

export function HeroAction({go}){return <section className="panel dash-hero dash-quiet">
  <div className="dash-hero-actions">
    <button className="dash-big-mint" onClick={()=>go('Minting')}>Mint</button>
    <QuickMintToggle go={go}/>
  </div>
</section>;}

export function PendingQueue({summary,go}){return <section className="panel dash-quiet">
  <h2>Pending items</h2>
  {summary.pendingConfirmations.length===0
    ?<Empty text="Nothing pending confirmation right now."/>
    :<div className="dash-plain-list">{summary.pendingConfirmations.map(item=><AdvancedRow key={item.id}
        summaryLine={`${item.triggerSource||'trigger'} - ${item.targetType} - waiting`}
        details={<><p>Contract: {item.preview?.contractAddress||'unknown'}</p><p>Method: {item.preview?.methodSignature||'unknown'}</p></>}/>)}</div>}
  <button className="quiet" onClick={()=>go('Activity')}>View activity</button>
</section>;}

export function StatsStrip({summary,go}){return <section className="panel dash-quiet">
  <h2>Quick stats</h2>
  <ul className="dash-plain-stats">
    <li>Total minted: <strong>{summary.totalMinted}</strong></li>
    <li>Recent success rate: <strong>{summary.successRate===null?'no data yet':`${summary.successRate}%`}</strong></li>
    <li>Gas spent: <strong>{formatAmount(summary.totalGasSpent)}</strong></li>
    <li>Net P&amp;L: <strong>{formatAmount(summary.netPnl)}</strong></li>
  </ul>
  <button className="quiet" onClick={()=>go('P&L')}>View P&amp;L</button>
</section>;}

export function TasksSnipersSummary({summary,go}){return <section className="panel dash-quiet">
  <h2>Tasks and snipers</h2>
  <p>{summary.tasksTotal} active tasks{summary.nextTaskTime?`. Next run: ${formatWhen(summary.nextTaskTime)}`:'.'}</p>
  <p>{summary.sniperCount} active snipers.</p>
  <div className="actions"><button onClick={()=>go('Tasks')}>View tasks</button><button onClick={()=>go('Snipers')}>View snipers</button></div>
</section>;}

export function WatchTargetSummary({summary,go}){return <section className="panel dash-quiet">
  <h2>Watch rules and target policies</h2>
  <p>{summary.watchRules.active} of {summary.watchRules.total} watch rules enabled.</p>
  <p>{summary.targetsTotal} targets under policy management.{summary.watchRules.needingAttention?` ${summary.watchRules.needingAttention} need attention.`:''}</p>
  <div className="actions"><button onClick={()=>go('Watch Rules')}>View watch rules</button><button onClick={()=>go('Target Policies')}>View target policies</button></div>
</section>;}

export function ActivityFeed({summary,go}){return <section className="panel dash-quiet">
  <h2>Recent activity</h2>
  {summary.activityItems.length===0
    ?<Empty text="No activity recorded yet."/>
    :<div className="dash-plain-list">{summary.activityItems.map(item=><AdvancedRow key={item.id}
        summaryLine={<><StatusPill status={item.status}/> {item.title} - {formatWhen(item.time)}</>}
        details={<><p>Wallet: {item.walletLabel||'none'}</p><p>Trigger: {item.triggerSource||'legacy/unrecorded'}</p><p>Verification: {item.verificationState||'not applicable'}</p></>}/>)}</div>}
  <button className="quiet" onClick={()=>go('Activity')}>View all activity</button>
</section>;}

export default {StatusBar,AlertBanner,HeroAction,PendingQueue,StatsStrip,TasksSnipersSummary,WatchTargetSummary,ActivityFeed};
