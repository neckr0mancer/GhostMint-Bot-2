/* global Blob, CustomEvent, navigator, URL, WebSocket, setTimeout */
import React,{useCallback,useEffect,useState} from 'react';

export const ACTIVITY_EVENTS=['snipers.changed','tasks.changed','watchrules.changed','wallets.changed'];

// Drop-in async replacements for window.confirm/window.prompt -- native browser dialogs can't be
// themed and look broken against the rest of the UI. Any component calls confirmDialog/promptDialog
// directly, exactly like the window.* functions they replace; the one <ConfirmHost/> mounted per
// shell renders whichever request is currently pending via this tiny module-level pub-sub (no
// context provider needed since there's only ever one dialog open at a time app-wide).
let activeDialogRequest=null;
let dialogRequestListeners=[];
function publishDialogRequest(request){activeDialogRequest=request;dialogRequestListeners.forEach(listener=>listener(request));}
function subscribeDialogRequest(listener){dialogRequestListeners.push(listener);return()=>{dialogRequestListeners=dialogRequestListeners.filter(item=>item!==listener);};}
export function confirmDialog(message){return new Promise(resolve=>{publishDialogRequest({type:'confirm',message,resolve:value=>{publishDialogRequest(null);resolve(value);}});});}
export function promptDialog(message,{defaultValue='',placeholder='',masked=false}={}){return new Promise(resolve=>{publishDialogRequest({type:'prompt',message,defaultValue,placeholder,masked,resolve:value=>{publishDialogRequest(null);resolve(value);}});});}
export function ConfirmHost(){
  const [request,setRequest]=useState(activeDialogRequest);
  useEffect(()=>subscribeDialogRequest(setRequest),[]);
  const [value,setValue]=useState('');
  useEffect(()=>{if(request?.type==='prompt')setValue(request.defaultValue||'');},[request]);
  function confirmChoice(){request.resolve(request.type==='confirm'?true:value);}
  function cancelChoice(){request.resolve(request.type==='confirm'?false:null);}
  useEffect(()=>{
    if(!request)return;
    function onKeyDown(event){
      if(event.key==='Escape'){event.preventDefault();cancelChoice();}
      else if(event.key==='Enter'&&request.type==='confirm'){event.preventDefault();confirmChoice();}
    }
    document.addEventListener('keydown',onKeyDown);
    return()=>document.removeEventListener('keydown',onKeyDown);
  },[request]);
  if(!request)return null;
  return <div className="confirm-modal-backdrop" onClick={cancelChoice}>
    <div className="confirm-modal" role="alertdialog" aria-modal="true" onClick={event=>event.stopPropagation()}>
      <p>{request.message}</p>
      {request.type==='prompt'&&<input autoFocus type={request.masked?'password':'text'} autoComplete="off" value={value} placeholder={request.placeholder} onChange={event=>setValue(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();confirmChoice();}}}/>}
      <div className="confirm-modal-actions">
        <button type="button" className="quiet" onClick={cancelChoice}>Cancel</button>
        <button type="button" onClick={confirmChoice}>{request.type==='prompt'?'OK':'Confirm'}</button>
      </div>
    </div>
  </div>;
}

// Toast notifications -- transient, auto-dismissing feedback for one-off events (a save succeeded,
// a write failed) that replace messages which used to sit at the top of a page until the next
// action or a full refresh cleared them. Same module-level pub-sub shape as the dialog above, but
// keeps a *list* since more than one toast can be visible at once. notify() is fire-and-forget;
// call it from anywhere, the one <ToastHost/> mounted per shell renders whatever's currently active.
let toastItems=[];
let toastListeners=[];
let toastSeq=0;
function publishToasts(){toastListeners.forEach(listener=>listener(toastItems));}
// Every notify() also appends to this longer-lived log (independent of the toast's own
// auto-dismiss), so the notification bell can show recent events you may have missed, not just
// pending confirmations. Capped rather than persisted -- it's a "what just happened" scratchpad,
// not a durable notification store.
let notificationLog=[];
let notificationLogListeners=[];
const NOTIFICATION_LOG_LIMIT=20;
function publishNotificationLog(){notificationLogListeners.forEach(listener=>listener(notificationLog));}
export function subscribeNotificationLog(listener){notificationLogListeners.push(listener);return()=>{notificationLogListeners=notificationLogListeners.filter(item=>item!==listener);};}
export function getNotificationLog(){return notificationLog;}
export function notify(message,{type='info',timeoutMs=5000}={}){
  if(!message)return null;
  const id=++toastSeq;
  toastItems=[...toastItems,{id,message,type,leaving:false}];
  publishToasts();
  notificationLog=[{id,message,type,at:Date.now()},...notificationLog].slice(0,NOTIFICATION_LOG_LIMIT);
  publishNotificationLog();
  if(timeoutMs>0)setTimeout(()=>dismissToast(id),timeoutMs);
  return id;
}
export function dismissToast(id){
  if(!toastItems.some(item=>item.id===id&&!item.leaving))return;
  toastItems=toastItems.map(item=>item.id===id?{...item,leaving:true}:item);
  publishToasts();
  setTimeout(()=>{toastItems=toastItems.filter(item=>item.id!==id);publishToasts();},220);
}
const TOAST_ICONS={
  success:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>,
  error:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>,
  info:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>,
};
export function ToastHost(){
  const [toasts,setToasts]=useState(toastItems);
  useEffect(()=>{
    const listener=next=>setToasts(next);
    toastListeners.push(listener);
    return()=>{toastListeners=toastListeners.filter(item=>item!==listener);};
  },[]);
  if(!toasts.length)return null;
  return <div className="toast-host" role="status" aria-live="polite">
    {toasts.map(toast=><div key={toast.id} className={`toast toast-${toast.type}${toast.leaving?' leaving':''}`}>
      <span className="toast-icon" aria-hidden="true">{TOAST_ICONS[toast.type]||TOAST_ICONS.info}</span>
      <span className="toast-message">{toast.message}</span>
      <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={()=>dismissToast(toast.id)}>×</button>
    </div>)}
  </div>;
}

const COPY_ICON_PROPS={viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",xmlns:"http://www.w3.org/2000/svg"};
const COPY_ICON=<svg {...COPY_ICON_PROPS}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/></svg>;
const CHECK_ICON=<svg {...COPY_ICON_PROPS} strokeWidth="2.4"><path d="M5 13l4 4L19 7"/></svg>;
// Small clipboard-copy button used next to every address-shaped value shown anywhere in the
// dashboard (wallet/contract addresses, tx hashes, platform account IDs) so a value never has to be
// selected and copied by hand. `value` is the raw string actually copied -- pass just the address,
// not a formatted display string, so copy-then-paste works directly.
export function CopyButton({value,label}){
  const [copied,setCopied]=useState(false);
  async function copy(event){
    event.stopPropagation();
    if(!value)return;
    try{await navigator.clipboard.writeText(value);setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{/* clipboard permission denied -- nothing more we can do */}
  }
  return <button type="button" className="user-card-copy" aria-label={label} onClick={copy}>{copied?CHECK_ICON:COPY_ICON}</button>;
}

// All chains the transaction engine currently supports are EVM (Ethereum, Base, Arbitrum, Polygon,
// and any future addition to src/config's CHAIN_DEFINITIONS) -- a single wallet address already
// works across every one of them. Solana is listed for visibility but is not wired up anywhere in
// the app (different key format, no provider/transaction-engine integration); it is always disabled.
export const EVM_CHAINS=['ethereum','base','arbitrum','polygon','robinhood','sepolia'];
export function GroupedChainOptions({options=[],labelFor=value=>value}){return <>
  <optgroup label="EVM">{options.filter(value=>EVM_CHAINS.includes(value)).map(value=><option key={value} value={value}>{labelFor(value)}</option>)}</optgroup>
  <optgroup label="Solana"><option value="solana" disabled>Solana (not yet supported)</option></optgroup>
</>;}

export function csrf(){return document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('ghostmint_csrf='))?.split('=').slice(1).join('=')||'';}
export async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.method&&options.method!=='GET'?{'X-CSRF-Token':decodeURIComponent(csrf())}:{})}});const body=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok){const error=new Error(body?.issues?.map(item=>`${item.field} ${item.message}`).join('; ')||body?.error||'Request failed');error.status=response.status;error.code=body?.code;throw error;}return body;}

// Triggers a client-side file save (used for the exported wallet keystore) via the standard
// Blob-URL-plus-synthetic-<a>-click pattern -- content never leaves the browser except through the
// download itself, since the anchor is never actually inserted into visible layout.
export function downloadFile(filename,content,mimeType='application/json'){
  const blob=new Blob([content],{type:mimeType});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download=filename;
  document.body.appendChild(link);link.click();document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
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
