import React,{useMemo,useState} from 'react';
import {Empty,PageTitle,StatusPill} from '../shared.jsx';
import {formatAmount,formatWhen} from './helpers.jsx';

const QUEUE_SCALE=10;

export function StatusBar({summary,go}){return <div className="dash-statusbar">
  <PageTitle eyebrow="Everything in one view" title="Dashboard" subtitle="A live summary of every tab below - drill into any card for the full picture."/>
  <div className="dash-statusbar-wallet">
    {summary.wallet
      ?<><span className="pill">{summary.wallet.chain}</span><strong>{summary.wallet.label}</strong><code>{summary.wallet.address}</code><span>{summary.wallet.balance??'Unavailable'} {summary.wallet.symbol||''}</span></>
      :<span>No wallets yet</span>}
    <button className="quiet small" onClick={()=>go('Wallets')}>View wallets</button>
    <span className="dash-bell" aria-label={`${summary.pendingConfirmations.length} pending confirmations`}>{summary.pendingConfirmations.length} pending</span>
  </div>
</div>;}

export function AlertBanner({summary}){if(!summary.lowBalanceWallets.length)return null;return <div className="notice error" role="alert">
  Low balance: {summary.lowBalanceWallets.map(wallet=>wallet.label).join(', ')} - top these up before minting.
</div>;}

export function HeroAction({go}){return <section className="panel dash-hero">
  <h2>New Mint</h2>
  <p>Jump straight into the Minting flow with simulation-backed previews.</p>
  <button onClick={()=>go('Minting')}>New mint</button>
</section>;}

export function PendingQueue({summary,go}){const percent=Math.min(100,Math.round(summary.pendingConfirmations.length/QUEUE_SCALE*100));return <section className="panel">
  <h2>Pending mints</h2>
  <p>{summary.pendingConfirmations.length} awaiting confirmation</p>
  <div className="dash-progress"><div className="dash-progress-bar" style={{width:`${percent}%`}}/></div>
  <button className="quiet small" onClick={()=>go('Activity')}>View activity</button>
</section>;}

export function StatsStrip({summary,go}){return <section className="panel">
  <h2>Quick stats</h2>
  <div className="dash-stat-grid dash-stat-tiles">
    <div><strong>{summary.totalMinted}</strong><span>Total minted</span></div>
    <div><strong>{summary.successRate===null?'-':`${summary.successRate}%`}</strong><span>Success rate</span></div>
    <div><strong>{formatAmount(summary.totalGasSpent)}</strong><span>Gas spent</span></div>
    <div><strong>{formatAmount(summary.netPnl)}</strong><span>Net P&amp;L</span></div>
  </div>
  <button className="quiet small" onClick={()=>go('P&L')}>View P&amp;L</button>
</section>;}

export function TasksSnipersSummary({summary,go}){return <section className="panel">
  <h2>Tasks &amp; snipers</h2>
  <p>{summary.tasksTotal} active tasks {summary.nextTaskTime?`- next run ${formatWhen(summary.nextTaskTime)}`:''}</p>
  <p>{summary.sniperCount} active snipers</p>
  <div className="actions"><button className="small" onClick={()=>go('Tasks')}>View tasks</button><button className="small" onClick={()=>go('Snipers')}>View snipers</button></div>
</section>;}

export function WatchTargetSummary({summary,go}){return <section className="panel">
  <h2>Watch rules &amp; target policies</h2>
  <p>{summary.watchRules.active} of {summary.watchRules.total} watch rules enabled</p>
  <p>{summary.targetsTotal} targets under policy management{summary.watchRules.needingAttention?<span className="warning"> - {summary.watchRules.needingAttention} need attention</span>:null}</p>
  <div className="actions"><button className="small" onClick={()=>go('Watch Rules')}>View watch rules</button><button className="small" onClick={()=>go('Target Policies')}>View target policies</button></div>
</section>;}

export function ActivityFeed({summary,go}){const [sort,setSort]=useState({key:'time',direction:'desc'});
  const rows=useMemo(()=>{const copy=[...summary.activityItems];copy.sort((a,b)=>{const left=String(a[sort.key]??'');const right=String(b[sort.key]??'');const compared=left.localeCompare(right);return sort.direction==='asc'?compared:-compared;});return copy;},[summary.activityItems,sort]);
  function toggleSort(key){setSort(current=>({key,direction:current.key===key&&current.direction==='asc'?'desc':'asc'}));}
  return <section className="panel dash-activity">
    <h2>Recent activity</h2>
    {rows.length===0?<Empty text="No activity recorded yet."/>:<div className="table-wrap"><table><thead><tr>
      <th><button type="button" className="sort-head" onClick={()=>toggleSort('title')}>Event</button></th>
      <th><button type="button" className="sort-head" onClick={()=>toggleSort('status')}>Status</button></th>
      <th><button type="button" className="sort-head" onClick={()=>toggleSort('time')}>When</button></th>
    </tr></thead><tbody>{rows.map(item=><tr key={item.id}><td>{item.title}</td><td><StatusPill status={item.status}/></td><td>{formatWhen(item.time)}</td></tr>)}</tbody></table></div>}
    <button className="quiet small" onClick={()=>go('Activity')}>View all activity</button>
  </section>;}

export default {StatusBar,AlertBanner,HeroAction,PendingQueue,StatsStrip,TasksSnipersSummary,WatchTargetSummary,ActivityFeed};
