/* global CustomEvent, WebSocket */
import React,{useCallback,useEffect,useState} from 'react';

export const ACTIVITY_EVENTS=['snipers.changed','tasks.changed','watchrules.changed','wallets.changed'];

// All chains the transaction engine currently supports are EVM (Ethereum, Base, Arbitrum, Polygon,
// and any future addition to src/config's CHAIN_DEFINITIONS) -- a single wallet address already
// works across every one of them. Solana is listed for visibility but is not wired up anywhere in
// the app (different key format, no provider/transaction-engine integration); it is always disabled.
export const EVM_CHAINS=['ethereum','base','arbitrum','polygon','sepolia'];
export function GroupedChainOptions({options=[],labelFor=value=>value}){return <>
  <optgroup label="EVM">{options.filter(value=>EVM_CHAINS.includes(value)).map(value=><option key={value} value={value}>{labelFor(value)}</option>)}</optgroup>
  <optgroup label="Solana"><option value="solana" disabled>Solana (not yet supported)</option></optgroup>
</>;}

export function csrf(){return document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('ghostmint_csrf='))?.split('=').slice(1).join('=')||'';}
export async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.method&&options.method!=='GET'?{'X-CSRF-Token':decodeURIComponent(csrf())}:{})}});const body=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok){const error=new Error(body?.issues?.map(item=>`${item.field} ${item.message}`).join('; ')||body?.error||'Request failed');error.status=response.status;error.code=body?.code;throw error;}return body;}
export function useLoad(path,dependencies=[],wsEvents){const [data,setData]=useState(null);const [error,setError]=useState('');const load=useCallback(()=>{setError('');return api(path).then(setData).catch(value=>setError(value.message));},[path,...dependencies]);useEffect(()=>{load();},[load]);useEffect(()=>{if(!wsEvents)return;const watched=[].concat(wsEvents);const listener=event=>{if(watched.includes(event.detail?.type))load();};window.addEventListener('ghostmint-ws',listener);return()=>window.removeEventListener('ghostmint-ws',listener);},[load,wsEvents]);return {data,error,load};}
// Opens the one live-update socket for the whole session (shared by both the regular dashboard
// shell and the admin shell, which previously never opened one at all -- so admin pages had no live
// listener). Every server-side change is broadcast as a 'ghostmint-ws' window CustomEvent; useLoad's
// wsEvents param subscribes a given resource to specific event types.
export function useLiveSocket(){const [live,setLive]=useState(false);useEffect(()=>{const protocol=window.location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(`${protocol}//${window.location.host}/ws`);socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='connected')setLive(true);window.dispatchEvent(new CustomEvent('ghostmint-ws',{detail:message}));};socket.onclose=()=>setLive(false);return()=>socket.close();},[]);return live;}
export function Notice({error,ok}){return <>{error&&<p className="notice error" role="alert">{error}</p>}{ok&&<p className="notice ok" role="status">{ok}</p>}</>}
export function statusClass(status){const value=String(status||'').toLowerCase();
  if(['confirmed','success','executed','enabled','healthy','submitted','resolved','up'].includes(value))return 'pill-success';
  if(['failed','rejected','disabled','expired','error','down'].includes(value))return 'pill-danger';
  if(['pending','executing','paused','skipped','no events'].includes(value))return 'pill-warning';
  return 'pill-neutral';}
export function StatusPill({status}){return <span className={`pill ${statusClass(status)}`}>{status}</span>}
export function PageTitle({eyebrow,title,subtitle}){return <div className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></div>}
export function Empty({text}){return <div className="panel"><p>{text}</p></div>}
export function Skeleton({rows=3,variant='card'}){return variant==='card'
  ?<div className="skeleton-grid" aria-hidden="true">{Array.from({length:rows}).map((_,index)=><div className="skeleton-card" key={index}/>)}</div>
  :<div className="skeleton-lines" aria-hidden="true">{Array.from({length:rows}).map((_,index)=><div className="skeleton-line" key={index}/>)}</div>}
export function Pager({value,page,setPage}){if(!value)return null;return <div className="pager"><button disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {value.page} of {value.totalPages} | {value.total} total</span><button disabled={page>=value.totalPages} onClick={()=>setPage(page+1)}>Next</button></div>}
