/* global clearInterval, setInterval */
import React,{useEffect,useState} from 'react';
import {countdownState} from '../countdown.js';

/* ==========================================================================
   Home page presentational parts (brief §3.3, §4; contract §3).

   A separate module from helpers.jsx deliberately. helpers.jsx holds QuickMint,
   which every one of the five theme widget packs imports; nothing in here is
   imported by the three secondary themes, so this file cannot regress them.
   Presentation only -- nothing here fetches or mutates.
   ========================================================================== */

const ICON=({d,...props})=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{d}</svg>;

export const ICONS={
  check:<ICON d={<path d="M5 13l4 4L19 7"/>}/>,
  cross:<ICON d={<path d="M18 6 6 18M6 6l12 12"/>}/>,
  chart:<ICON d={<path d="M3 17l5-6 4 3 5-8"/>}/>,
  clock:<ICON d={<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>}/>,
  wallet:<ICON d={<><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/></>}/>,
  alert:<ICON d={<><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></>}/>,
  queue:<ICON d={<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>}/>,
};

/* --- Chain identity (brief §3.3) -----------------------------------------
   The activity table has no chain column (contract §5.8), so the dot is derived
   from the row's block-explorer URL. sepolia.etherscan.io contains "etherscan.io",
   so the testnet host MUST be tested before the mainnet one -- reversing these two
   entries silently relabels every Sepolia row as Ethereum. */
const EXPLORER_CHAINS=[
  ['sepolia.etherscan.io','sepolia'],
  ['etherscan.io','ethereum'],
  ['basescan.org','base'],
  ['arbiscan.io','arbitrum'],
  ['polygonscan.com','polygon'],
  ['robinhoodchain','robinhood'],
];
export const CHAIN_LOOK={
  ethereum:{label:'Ethereum',color:'#627eea'},
  base:{label:'Base',color:'#0052ff'},
  arbitrum:{label:'Arbitrum',color:'#12aaff'},
  polygon:{label:'Polygon',color:'#8247e5'},
  robinhood:{label:'Robinhood',color:'#00c805'},
  sepolia:{label:'Sepolia',color:'#8f9aa6'},
};
const CHAIN_EXPLORERS={
  ethereum:'https://etherscan.io/tx/',base:'https://basescan.org/tx/',
  arbitrum:'https://arbiscan.io/tx/',polygon:'https://polygonscan.com/tx/',
  robinhood:'https://robinhoodchain.blockscout.com/tx/',sepolia:'https://sepolia.etherscan.io/tx/',
};
export function explorerForChain(chain){return CHAIN_EXPLORERS[chain]||null;}
export function chainFromExplorer(explorer){
  if(!explorer)return null;
  const value=String(explorer).toLowerCase();
  const hit=EXPLORER_CHAINS.find(([host])=>value.includes(host));
  return hit?hit[1]:null;
}
export function ChainDot({chain}){
  const look=CHAIN_LOOK[chain];
  if(!look)return null;
  // The name is rendered as text alongside the dot, never colour alone -- the dot is an
  // identity aid, not the identity itself.
  return <span className="chain-tag"><i style={{background:look.color}} aria-hidden="true"/>{look.label}</span>;
}

/* --- Formatting ---------------------------------------------------------- */
// null/undefined are rejected BEFORE Number(), because Number(null) is 0 and 0 is finite -- so
// the obvious one-liner renders a missing ceiling as "0.000", i.e. "you may spend nothing",
// when the truth is "there is no ceiling". On a money surface those must never look alike.
export function formatEth(value,digits=3){
  if(value===null||value===undefined)return '—';
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed.toFixed(digits):'—';
}
// A signed figure always carries its sign character, because colour is the secondary channel
// and must never be the only thing distinguishing a gain from a loss (brief §4, condition 2).
// U+2212 MINUS SIGN, not a hyphen: it aligns with digit width in a tabular-nums column.
export function formatSigned(value,digits=3){
  const parsed=Number(value);
  if(!Number.isFinite(parsed))return '—';
  const fixed=Math.abs(parsed).toFixed(digits);
  if(Number(fixed)===0)return `0.${'0'.repeat(digits)}`;
  return `${parsed<0?'−':'+'}${fixed}`;
}
export function shortAddress(address){
  const value=String(address||'');
  return value.length>12?`${value.slice(0,6)}…${value.slice(-4)}`:value;
}
export function weiToEth(wei){
  if(wei===null||wei===undefined)return null;
  try{return Number(BigInt(wei))/1e18;}catch{const parsed=Number(wei);return Number.isFinite(parsed)?parsed/1e18:null;}
}

/* --- Countdown ring (brief §3.3) -----------------------------------------
   Re-renders on a 1s interval only while a future target exists; the effect tears the
   timer down as soon as the target passes or unmounts, so an idle Home holds no timer. */
const RING_CIRCUMFERENCE=2*Math.PI*17;
export function CountdownRing({target,from,title,meta}){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    if(!target)return undefined;
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>clearInterval(timer);
  },[target]);
  const state=countdownState(target,from,now);
  if(!state)return null;
  const {targetMs,remaining,clock,progress}=state;
  // The arc fills across THIS mint's own wait -- from the moment it was scheduled to the moment
  // it fires -- so it starts empty and ends full whatever the distance.
  //
  // It used to fill over a fixed final hour, which is wrong at both ends of the range. A mint two
  // minutes out rendered 96.7% full on its very first frame and crept the last 3%: technically
  // "filling as it approaches", but on screen it was a stuck green ring. A mint days out sat at
  // exactly zero for days. Scaling to the actual wait fixes both, and needs nothing the row does
  // not already carry -- createdAt is set when the task is written.
  return <div className="ring">
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="17" fill="none" stroke="var(--surface-4)" strokeWidth="4"/>
      <circle cx="20" cy="20" r="17" fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE*(1-progress)}
        transform="rotate(-90 20 20)"/>
    </svg>
    <div>
      <div className="ring-time tab">{remaining===0?'due now':clock}</div>
      <div className="ring-sub">{title}</div>
      <div className="ring-meta">Due {new Date(targetMs).toLocaleString()}</div>
      {meta&&<div className="ring-meta"><span className="pill">{meta}</span></div>}
    </div>
  </div>;
}

/* --- Rows ---------------------------------------------------------------- */
export function Row({icon,tone,title,sub,value,valueLabel,valueTone}){
  return <div className="row">
    {icon&&<div className={`row-icon${tone?` row-icon-${tone}`:''}`}>{icon}</div>}
    <div className="row-main">
      <div className="row-title">{title}</div>
      {sub&&<div className="row-sub">{sub}</div>}
    </div>
    {value!==undefined&&<div className={`row-value tab${valueTone?` row-value-${valueTone}`:''}`}>
      {valueLabel&&<span className="row-value-label">{valueLabel}</span>}{value}
    </div>}
  </div>;
}

/* --- Empty state (brief §3.7) --------------------------------------------
   An empty state is a screen, not a sentence: icon, what this surface is for, and the one
   action that ends the emptiness. Rendered only once data has actually arrived -- the caller
   gates on `data !== null`, never on `length === 0` alone. */
export function EmptyState({icon,title,children,action}){
  return <div className="empty-state">
    {icon&&<div className="empty-icon">{icon}</div>}
    <h3>{title}</h3>
    {children&&<p>{children}</p>}
    {action}
  </div>;
}
