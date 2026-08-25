/* global Blob, clearTimeout, CustomEvent, localStorage, navigator, URL, WebSocket, setTimeout */
import React,{useCallback,useEffect,useId,useRef,useState} from 'react';

export {ACTIVITY_EVENTS} from './activityFeed.js';

// The rail preference and this single layout document are deliberately the only layout values in
// localStorage (REDESIGN_BRIEF §3.6). Each page owns a key inside the document, so adding another
// reorderable page never creates another browser-storage key. The reserved `dismissedRewards`
// field remembers which one-off success panel was dismissed; its activity key changes when a new
// confirmed mint arrives, so the next real event is shown without inventing another storage key.
const SECTION_ORDER_KEY='ghostmint-section-order';
const SECTION_ORDER_RESET_EVENT='ghostmint-section-order-reset';
const DISMISSED_REWARDS_FIELD='dismissedRewards';

function normalizedSectionOrder(saved,ids){
  const allowed=new Set(ids);
  const kept=Array.isArray(saved)?saved.filter((id,index)=>allowed.has(id)&&saved.indexOf(id)===index):[];
  return [...kept,...ids.filter(id=>!kept.includes(id))];
}
function storedSectionOrders(){
  try{const value=JSON.parse(localStorage.getItem(SECTION_ORDER_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
  catch{return {};}
}
function saveSectionOrder(stackKey,order){
  try{localStorage.setItem(SECTION_ORDER_KEY,JSON.stringify({...storedSectionOrders(),[stackKey]:order}));}
  catch{/* Storage can be disabled; reordering still works for the current mounted page. */}
}
export function readDismissedReward(scope){
  const dismissed=storedSectionOrders()[DISMISSED_REWARDS_FIELD];
  return dismissed&&typeof dismissed==='object'&&!Array.isArray(dismissed)?dismissed[scope]??null:null;
}
export function saveDismissedReward(scope,itemKey){
  if(!scope||itemKey===null||itemKey===undefined)return;
  try{
    const current=storedSectionOrders();
    const dismissed=current[DISMISSED_REWARDS_FIELD];
    const saved=dismissed&&typeof dismissed==='object'&&!Array.isArray(dismissed)?dismissed:{};
    localStorage.setItem(SECTION_ORDER_KEY,JSON.stringify({
      ...current,
      [DISMISSED_REWARDS_FIELD]:{...saved,[scope]:String(itemKey)},
    }));
  }catch{/* Dismissal still works in component state when browser storage is unavailable. */}
}
export function resetSectionOrders(){
  // Reset means layout order only. It must not resurrect an event the user deliberately dismissed.
  try{
    const dismissed=storedSectionOrders()[DISMISSED_REWARDS_FIELD];
    if(dismissed&&typeof dismissed==='object'&&!Array.isArray(dismissed)){
      localStorage.setItem(SECTION_ORDER_KEY,JSON.stringify({[DISMISSED_REWARDS_FIELD]:dismissed}));
    }else localStorage.removeItem(SECTION_ORDER_KEY);
  }catch{/* The in-page reset still applies below. */}
  document.dispatchEvent(new CustomEvent(SECTION_ORDER_RESET_EVENT));
}

// A real counterpart to the prototype's .blk/.dragh chrome. The handle alone is draggable (the
// card header remains free for mobile collapse), and ArrowUp/ArrowDown provide the mandatory
// keyboard equivalent. Only rendered order changes; the children and their data requests do not.
export function ReorderableStack({stackKey,items,className=''}){
  // Keep temporarily-hidden blocks (a dismissed reward, an empty alert panel) in the stored order.
  // Dropping them from `ids` while data loads made them reappear at the bottom instead of their
  // prototype position once the request completed.
  const allItems=items.filter(Boolean);
  const ids=allItems.map(item=>item.id);
  const idsKey=ids.join('\u001f');
  const [order,setOrder]=useState(()=>normalizedSectionOrder(storedSectionOrders()[stackKey],ids));
  const [dragging,setDragging]=useState(null);
  useEffect(()=>{setOrder(current=>normalizedSectionOrder(current,ids));},[stackKey,idsKey]);
  useEffect(()=>{const reset=()=>setOrder(ids);document.addEventListener(SECTION_ORDER_RESET_EVENT,reset);
    return()=>document.removeEventListener(SECTION_ORDER_RESET_EVENT,reset);},[idsKey]);
  function commit(next){setOrder(next);saveSectionOrder(stackKey,next);}
  const byId=new Map(allItems.map(item=>[item.id,item]));
  const renderedOrder=normalizedSectionOrder(order,ids).filter(id=>byId.get(id)?.visible!==false);
  function moveBy(id,delta){
    const current=normalizedSectionOrder(order,ids);const from=renderedOrder.indexOf(id);
    const to=Math.max(0,Math.min(renderedOrder.length-1,from+delta));if(from<0||from===to)return;
    const target=renderedOrder[to];const next=current.filter(value=>value!==id);
    const targetAt=next.indexOf(target);next.splice(delta<0?targetAt:targetAt+1,0,id);commit(next);
  }
  function moveBefore(id,target){
    if(!id||id===target)return;const current=normalizedSectionOrder(order,ids);
    const next=current.filter(value=>value!==id);const at=next.indexOf(target);if(at<0)return;
    next.splice(at,0,id);commit(next);
  }
  return <div className={className} data-reorder={stackKey}>
    {renderedOrder.map((id,index)=>{const item=byId.get(id);if(!item)return null;
      return <div className={`blk${dragging===id?' is-dragging':''}`} key={id}
        onDragOver={event=>{if(dragging&&dragging!==id)event.preventDefault();}}
        onDrop={event=>{event.preventDefault();moveBefore(dragging||event.dataTransfer.getData('text/plain'),id);setDragging(null);}}>
        <button type="button" className="dragh" draggable="true"
          title="Drag to move · arrow keys to reorder"
          aria-label={`Reorder ${item.label||'this section'}; item ${index+1} of ${renderedOrder.length}`}
          onDragStart={event=>{setDragging(id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',id);}}
          onDragEnd={()=>setDragging(null)}
          onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();moveBy(id,event.key==='ArrowUp'?-1:1);}}}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </button>
        {item.content}
      </div>;})}
  </div>;
}

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
        <button type="button" className="b g" onClick={cancelChoice}>Cancel</button>
        <button type="button" className="b p" onClick={confirmChoice}>{request.type==='prompt'?'OK':'Confirm'}</button>
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
// `category` is the prototype's .bell-cat chip on a Recent row: Money / Auto / Security. It is
// optional and defaults to nothing rather than being guessed from the message text -- an entry
// wearing the wrong domain is worse than one wearing none, and a keyword sniffer would be wrong
// silently. Call sites that know their domain pass it; the rest render no chip.
export const NOTIFICATION_CATEGORIES=Object.freeze({money:'Money',auto:'Auto',security:'Security'});
// `action` is the owner's rule generalised: any notification about something that can be retried,
// resumed or reviewed carries the control to do it, so reading the notification and acting on it
// are the same gesture rather than a trip back to the page it came from. Shape is
// {label, run} -- run() may be async, and the bell disables the button while it is in flight.
export function notify(message,{type='info',timeoutMs=5000,category,action}={}){
  if(!message)return null;
  const id=++toastSeq;
  toastItems=[...toastItems,{id,message,type,leaving:false}];
  publishToasts();
  notificationLog=[{id,message,type,category,action,at:Date.now()},...notificationLog].slice(0,NOTIFICATION_LOG_LIMIT);
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
export const EVM_CHAINS=['ethereum','base','arbitrum','polygon','robinhood'];
export function GroupedChainOptions({options=[],labelFor=value=>value}){return <>
  <optgroup label="EVM">{options.filter(value=>EVM_CHAINS.includes(value)).map(value=><option key={value} value={value}>{labelFor(value)}</option>)}</optgroup>
  <optgroup label="Solana"><option value="solana" disabled>Solana (not yet supported)</option></optgroup>
</>;}

export function csrf(){return document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('ghostmint_csrf='))?.split('=').slice(1).join('=')||'';}
export async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.method&&options.method!=='GET'?{'X-CSRF-Token':decodeURIComponent(csrf())}:{})}});const body=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok){const error=new Error(body?.issues?.map(item=>`${item.field} ${item.message}`).join('; ')||body?.error||'Request failed');error.status=response.status;error.code=body?.code;error.reason=body?.reason;// The per-field issues are kept ON the error, not just flattened into its message. The prototype's validation state (.in.bad + .fielderr under the offending field) needs to know WHICH field failed; without this it could never fire, and both Mint now and Schedule were silently falling back to a toast.
  error.issues=body?.issues;error.retryAfter=response.headers.get('Retry-After');if(response.status===401&&!path.startsWith('/api/auth/login'))window.dispatchEvent(new CustomEvent('ghostmint-session-ended',{detail:{message:error.message,reason:error.reason}}));throw error;}return body;}

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
// `status` carries api()'s HTTP status alongside the message so a failure surface can render the
// code (brief §3.8 requires it visible: "it said 429" is the single most useful thing a user can
// report back). It was being discarded here -- api() sets .status on the thrown Error, and this
// catch kept only .message, so no caller could ever show it.
// A null path means "not yet" -- the caller has nothing to fetch for the current state (a tab that
// has not been opened, an id that is not chosen). It stays in the loading shape rather than firing
// a request for the string "null", so a panel can defer its own load until someone looks at it.
export function useLoad(path,dependencies=[],wsEvents){const [data,setData]=useState(null);const [error,setError]=useState('');const [status,setStatus]=useState(null);const load=useCallback(()=>{if(!path)return Promise.resolve();setError('');setStatus(null);return api(path).then(setData).catch(value=>{setError(value.message);setStatus(value.status??null);});},[path,...dependencies]);useEffect(()=>{load();},[load]);useEffect(()=>{if(!wsEvents)return;const watched=[].concat(wsEvents);const listener=event=>{if(event.detail?.type==='ws.reconnected'||watched.includes(event.detail?.type))load();};window.addEventListener('ghostmint-ws',listener);return()=>window.removeEventListener('ghostmint-ws',listener);},[load,wsEvents]);return {data,error,status,load};}
// Opens the one live-update socket for the whole session (shared by both the regular dashboard
// shell and the admin shell, which previously never opened one at all -- so admin pages had no live
// listener). Every server-side change is broadcast as a 'ghostmint-ws' window CustomEvent; useLoad's
// wsEvents param subscribes a given resource to specific event types.
export function useLiveSocket(){const [live,setLive]=useState(false);useEffect(()=>{const protocol=window.location.protocol==='https:'?'wss:':'ws:';let socket=null;let retryTimer=null;let stopped=false;let attempt=0;let connectedOnce=false;let needsResync=false;function connect(){if(stopped)return;socket=new WebSocket(`${protocol}//${window.location.host}/ws`);socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}if(message.type==='connected'){setLive(true);attempt=0;if(connectedOnce||needsResync)window.dispatchEvent(new CustomEvent('ghostmint-ws',{detail:{type:'ws.reconnected'}}));connectedOnce=true;needsResync=false;}window.dispatchEvent(new CustomEvent('ghostmint-ws',{detail:message}));};socket.onclose=()=>{setLive(false);if(stopped)return;needsResync=true;const delay=Math.min(30_000,1_000*(2**attempt));attempt+=1;retryTimer=setTimeout(connect,delay);};}connect();return()=>{stopped=true;if(retryTimer)clearTimeout(retryTimer);socket?.close();};},[]);return live;}
// Two shapes, deliberately. `error` as a STRING keeps the original one-line notice every existing
// caller passes (useLoad's error is always a string). `error` as an OBJECT renders the richer
// failure surface brief §3.8 requires on a money surface: what failed, what was NOT changed, the
// status code shown visibly, and a Retry. The status code is rendered rather than swallowed
// because "it said 429" is the single most useful thing a user can tell you.
// Prototype .notice (docs/prototype-pages/mint.html, auto.html, admin.html): a flex row of
// warning glyph + .nb body, where the title is a <b> (block, via prototype.css), the detail is
// plain text and the status code is a <code> at the end -- NOT a coloured heading with a chip.
// The prototype's .notice is inherently the error treatment; informational and warning notes are
// a different component there (.nt.i / .nt.w / .nt.e), which is what the string variants map to.
const NOTICE_GLYPH=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>;
// Every prototype page draws the SAME error shape (.notice.ox): a bold sentence naming what
// failed, the status code and "Request failed safely" together in a <code>, and a Retry button.
// Built here rather than at each call site because there are eight of them and they had already
// drifted -- every one passed a bare string, so none of them offered the Retry at all, which is
// the part that turns an error state from a dead end into something the user can act on.
export { batchRowDetail } from './batchRow.js';
export function loadError(listing,title){
  if(!listing?.error)return null;
  return {title,onRetry:listing.load,
    code:listing.status?listing.status+' · Request failed safely':'Request failed safely'};
}
export function Notice({error,ok}){
  if(error&&typeof error==='object'){
    const {title,detail,code,onRetry}=error;
    return <div className="notice" role="alert">
      {NOTICE_GLYPH}
      <div className="nb"><b>{title||'Something failed'}</b>
        {detail&&<>{detail} </>}
        {code!==undefined&&code!==null&&<code>{code}</code>}
        {onRetry&&<div className="br" style={{marginTop:'9px'}}><button type="button" className="b sm" onClick={onRetry}>Retry</button></div>}
      </div>
    </div>;
  }
  return <>
    {error&&<div className="nt e" role="alert">{NOTICE_GLYPH}<div className="nb">{error}</div></div>}
    {ok&&<div className="nt i" role="status">{NOTICE_GLYPH}<div className="nb">{ok}</div></div>}
  </>;
}
// FirstRun -- the prototype's .frun panel (docs/prototype-pages/home.html). Copy, step order
// and button classes are verbatim; .frun / .steps / .step / .sn / .st / .sd all already exist in
// prototype.css, so this component adds markup only. The "now" step is the first one the user
// has not completed, so the panel keeps working as they progress rather than being a static card:
//   no wallet        -> step 1
//   wallet, no funds -> step 2
//   funded, no mints -> step 3
export function FirstRun({step=1,go}){
  const steps=[
    {n:1,title:'Create a wallet',detail:'Generated and encrypted on the server. You get the address, never the key.'},
    {n:2,title:'Fund it',detail:'Send ETH to the address. Works on Ethereum, Base, Arbitrum and Polygon.'},
    {n:3,title:'Paste a contract and mint',detail:'Price, supply and per-wallet limits are detected for you.'},
  ];
  return <div className="g" style={{marginBottom:'11px'}}>
    <div className="frun">
      <h2>Let&rsquo;s get you minting.</h2>
      <p>Nothing here yet &mdash; that&rsquo;s expected. GhostMint generates and encrypts the key server-side, so you never handle it.</p>
      <div className="steps">
        {steps.map(item=><div key={item.n} className={item.n===step?'step now':'step'}>
          <span className="sn">{item.n}</span>
          <div><div className="st">{item.title}</div><div className="sd">{item.detail}</div></div>
        </div>)}
      </div>
      <div className="br">
        <button type="button" className="b p" onClick={()=>go('Wallets')}>Create my first wallet</button>
        <button type="button" className="b g" onClick={()=>go('Settings')}>How it works</button>
      </div>
    </div>
  </div>;
}
// Quantity quick-picks. The prototype writes three different literal sets -- "1 2 3 Max" on Mint
// now, "1 2 5" on Schedule, "1 2 3" on Batch -- because each form has a different cap. The owner
// asked for the RULE behind those literals rather than the literals themselves (2026-08-18), so
// the ladder is derived from the cap and every form shares it:
//
//   1 and 2 always, then the largest round step at or below half the cap, then Max.
//
//   cap   3 -> 1, 2, 3, Max      (identical to the prototype's Mint now)
//   cap   5 -> 1, 2, 5, Max
//   cap   6 -> 1, 2, 3, Max
//   cap  10 -> 1, 2, 5, Max
//   cap 100 -> 10, 20, 50, Max  (scales with the cap so large mints get useful steps)
// If that third step would collide with 1 or 2 the cap itself is used, which is what keeps small
// caps sensible instead of rendering "1, 2, 2". This is a DELIBERATE, owner-approved departure
// from the prototype's hardcoded values -- see REDESIGN_FIDELITY_BACKLOG.md §13.
const QUANTITY_LADDER=[1,2,3,5,10,20,25,50,100];
export function quantityPicks(max){
  const cap=Number(max)>0?Math.floor(Number(max)):1;
  if(cap<=2)return Array.from({length:cap},(_,index)=>index+1);
  if(cap<=10){
    const candidate=[...QUANTITY_LADDER].reverse().find(value=>value<=cap/2);
    const third=candidate&&candidate>2?candidate:cap;
    return [...new Set([1,2,third])].filter(value=>value<=cap);
  }
  const pick=(fraction)=>{
    const raw=cap*fraction;
    const candidate=[...QUANTITY_LADDER].reverse().find(value=>value<=raw);
    return candidate||Math.max(1,Math.floor(raw));
  };
  const p1=pick(0.1),p2=pick(0.2),p3=pick(0.5);
  return [...new Set([p1,p2,p3])].filter(value=>value>=1&&value<=cap).sort((a,b)=>a-b);
}
export function relativeTime(at){const seconds=Math.max(0,Math.floor((Date.now()-at)/1000));if(seconds<5)return 'just now';if(seconds<60)return `${seconds}s ago`;const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m ago`;const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ago`;return `${Math.floor(hours/24)}d ago`;}
// Carries the contract address (and whatever else was already typed) from Quick Mint's "Advanced
// options" hand-off into the full Minting page, so the field it lands on isn't empty and detection
// can fire immediately -- a plain module-level value is enough since this is a same-tab SPA
// navigation (go() just swaps which component renders, never a real page load), not real
// cross-request state.
let pendingMintPrefill=null;
export function setPendingMintPrefill(value){pendingMintPrefill=value;}
export function consumePendingMintPrefill(){const value=pendingMintPrefill;pendingMintPrefill=null;return value;}
// The one Form/Field/Select family every dashboard form is built from -- previously duplicated
// separately in App.jsx and Admin.jsx (and not available to Dashboard.jsx at all, since it can't
// import from App.jsx without a cycle), which is how Quick Mint ended up with its own raw
// <label><input> markup instead of matching the rest of the app.
// `busy` is the in-flight lock GHOSTMINT_UI_RULES.md requires of every mutating form. It defaults
// to false so all 19 existing callers keep their exact current behaviour.
//
// The <fieldset> goes INSIDE .fields rather than around it, which looks arbitrary and is not:
// styles.css has two direct-child selectors (`.admin-owner-layout>.panel>.fields`), and while
// `fieldset{display:contents}` removes the element from the LAYOUT tree, CSS selectors match the
// DOM tree -- so wrapping .fields would silently break the admin owner grid. Nesting it inward
// keeps .fields a direct child of the form, and display:contents lets the real controls go on
// participating in the .fields grid exactly as before.
export function Form({title,note,warning,onSubmit,children,className='',busy=false}){return <form className={`panel form ${className}`.trim()} onSubmit={onSubmit} aria-busy={busy||undefined}><h2>{title}</h2>{note&&<p>{note}</p>}{warning&&<p className="warning">{warning}</p>}<div className="fields"><fieldset disabled={busy}>{children}</fieldset></div></form>}
export function Field({label,required=true,...props}){return <label>{label}<input required={required} {...props}/></label>}
export function Select({label,options=[],optional=false,...props}){return <label>{label}<select required={!optional} {...props}>{optional&&<option value="">None</option>}{options?.map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
export function statusClass(status){const value=String(status||'').toLowerCase();
  if(['confirmed','success','executed','enabled','healthy','submitted','resolved','up'].includes(value))return 'pill-success';
  if(['failed','rejected','disabled','expired','error','down'].includes(value))return 'pill-danger';
  if(['pending','executing','paused','skipped','no events'].includes(value))return 'pill-warning';
  return 'pill-neutral';}
export function StatusPill({status}){return <span className={`pill ${statusClass(status)}`}>{status}</span>}
export function PageTitle({eyebrow,title,subtitle}){return <div className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></div>}
export function Empty({text}){return <div className="panel"><p>{text}</p></div>}
// 'card' and 'lines' are the original two and keep their exact markup; the rest are the shapes the
// prototype draws under its Loading toggle. A skeleton must echo the SHAPE of what is coming --
// a big-value tile that loads into three text lines reads as a layout jump, not as loading.
const SKELETON_SHAPES={line:'skeleton-line',row:'skeleton-row','big-value':'skeleton-big',chart:'skeleton-chart'};
export function Skeleton({rows=3,variant='card'}){
  if(variant==='card')return <div className="skeleton-grid" aria-hidden="true">{Array.from({length:rows}).map((_,index)=><div className="skeleton-card" key={index}/>)}</div>;
  if(variant==='lines')return <div className="skeleton-lines" aria-hidden="true">{Array.from({length:rows}).map((_,index)=><div className="skeleton-line" key={index}/>)}</div>;
  const shape=SKELETON_SHAPES[variant]||'skeleton-line';
  return <div className="skeleton-lines" aria-hidden="true">{Array.from({length:rows}).map((_,index)=><div className={shape} key={index}/>)}</div>;
}
// Prototype .pager (docs/prototype-pages/mint.html:148): a .pinfo count that pushes everything
// right, then a single-glyph prev, numbered pages with the current one .on, and a single-glyph
// next. Not "Previous / Page 1 of 3 / Next" -- the numbers are the control, the arrows are the
// nudge. Window of five keeps a long list from spilling its own row.
export function Pager({value,page,setPage}){
  // Nothing to page through, nothing to say. A pager over an empty or single-page list is
  // noise: its whole job is to report what is being truncated, and neither case truncates.
  if(!value||!value.total||value.totalPages<=1)return null;
  const total=value.totalPages;
  // THREE numbers, sliding. The window keeps the current page as its LAST entry once you are past
  // page 3, so pages 1-3 read "1 2 3" and stepping to 4 reads "2 3 4" -- the fourth number appears
  // by arriving at it, not by sitting there in advance. Owner's rule, 2026-08-19.
  const WINDOW=3;
  const first=Math.max(1,Math.min(page-(WINDOW-1),total-(WINDOW-1)));
  const numbers=[];
  for(let n=first;n<=Math.min(total,first+WINDOW-1);n++)numbers.push(n);
  const shown=Math.min(value.page*value.pageSize,value.total);
  // Jump-to-end arrows appear only past three pages. Below that every page is already one click
  // away on a numbered button, so a second pair of arrows would be four controls doing the work
  // of none. Owner's rule, 2026-08-19.
  const jumps=total>3;
  // Disabled rather than hidden at the ends, matching the single arrows and .pager button[disabled]
  // (prototype.css:145). A control that vanishes moves everything beside it, so the row would
  // reflow under the cursor as you reach the last page -- the reason the ends stay occupied.
  return <div className="pager">
    <span className="pinfo">{shown} of {value.total}</span>
    {jumps&&<button type="button" disabled={page<=1} aria-label="First page"
      onClick={()=>setPage(1)}>&laquo;</button>}
    <button type="button" disabled={page<=1} aria-label="Previous page" onClick={()=>setPage(page-1)}>&lsaquo;</button>
    {numbers.map(n=><button type="button" key={n} className={n===page?'on':undefined}
      aria-current={n===page?'page':undefined} onClick={()=>setPage(n)}>{n}</button>)}
    <button type="button" disabled={page>=total} aria-label="Next page" onClick={()=>setPage(page+1)}>&rsaquo;</button>
    {jumps&&<button type="button" disabled={page>=total} aria-label="Last page"
      onClick={()=>setPage(total)}>&raquo;</button>}
  </div>;
}

/* ==========================================================================
   New presentational components (brief §5). Presentation only -- none of these
   fetch, mutate, or hold anything but their own display state.
   ========================================================================== */

// The card every .panel becomes. Head slot carries an optional accent-tinted icon chip and an
// actions slot, so a card header never has to be hand-assembled per page again.
export function SectionCard({title,icon,actions,children,className='',mobileCollapsible=false,
  mobileDefaultOpen=true,collapsedLeading,collapsedValue}){
  const [open,setOpen]=useState(mobileDefaultOpen);
  const bodyId=`section-${useId().replaceAll(':','')}`;
  if(!mobileCollapsible)return <section className={`panel section-card ${className}`.trim()}>
    {(title||actions)&&<div className="section-head">
      {icon&&<span className="section-icon" aria-hidden="true">{icon}</span>}
      {title&&<h2>{title}</h2>}
      {actions&&<div className="section-actions">{actions}</div>}
    </div>}
    {children}
  </section>;
  return <section className={`panel section-card${mobileCollapsible?' col':''} ${className}`.trim()}
    data-open={mobileCollapsible?(open?'1':'0'):undefined}>
    {mobileCollapsible&&<button type="button" className="colh" aria-expanded={open}
      aria-controls={bodyId} onClick={()=>setOpen(value=>!value)}>
      {collapsedLeading&&<span className="p nu">{collapsedLeading}</span>}
      <span className="cti">{title}</span>
      {collapsedValue!==null&&collapsedValue!==undefined&&<span className="ctv">{collapsedValue}</span>}
      <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>}
    <div className={mobileCollapsible?'colb':undefined} id={mobileCollapsible?bodyId:undefined}>
      {(title||actions)&&<div className="section-head">
        {icon&&<span className="section-icon" aria-hidden="true">{icon}</span>}
        {title&&<h2>{title}</h2>}
        {actions&&<div className="section-actions">{actions}</div>}
      </div>}
      {children}
    </div>
  </section>;
}

// Label / value / meta, with room in the bottom-right corner for a Sparkline or Meter. `value` is
// rendered as given -- callers format it -- so a real 0 arrives here as "0" and prints as "0".
export function StatTile({label,value,unit,meta,tone,children}){
  return <div className="tile">
    <div className="tile-label">{label}</div>
    <div className={`tile-value tab${tone?` tile-${tone}`:''}`}>{value}{unit&&<small>{unit}</small>}</div>
    {meta&&<div className="tile-meta">{meta}</div>}
    {children}
  </div>;
}

// The register-1 table: label left, figure right, tabular-nums, hairline rules, no decoration.
// Rows are {label, value, mono?, tone?}; `total` is an optional emphasised final row.
export function Ledger({rows=[],total,className=''}){
  return <dl className={`ledger ${className}`.trim()}>
    {rows.map((row,index)=><div className="ledger-row" key={row.label??index}>
      <dt>{row.label}</dt>
      <dd className={`ledger-value tab${row.mono?' mono':''}${row.tone?` ledger-${row.tone}`:''}`}>{row.value}</dd>
    </div>)}
    {total&&<div className="ledger-row ledger-total">
      <dt>{total.label}</dt><dd className="ledger-value tab">{total.value}</dd>
    </div>}
  </dl>;
}

// Register 4, and the only component allowed to be warm. Renders after a confirmed outcome only.
export function Celebrate({title,detail,children}){
  return <div className="cel" role="status">
    <div className="cel-b" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>
    </div>
    <h3>{title}</h3>
    {detail&&<p>{detail}</p>}
    {children}
  </div>;
}

// Consolidates the .page-search pattern and finally adds the themed in-input clear the UI rules
// have required all along -- shown only when there is text, clears the query only, and returns
// focus to the input so typing continues uninterrupted.
//
// onChange receives the VALUE, not the event: every existing call site does e.target.value at the
// callsite, and this is a new component with no callers yet, so it gets the cleaner contract.
export function SearchField({label,value='',onChange,placeholder='Label, address, chain…',id,name}){
  const inputRef=useRef(null);
  function clear(){onChange('');inputRef.current?.focus();}
  return <label className="page-search search-field">{label}
    <span className="search-field-control">
      <input ref={inputRef} id={id} name={name} type="search" value={value} placeholder={placeholder}
        onChange={event=>onChange(event.target.value)}/>
      {value!==''&&<button type="button" className="search-clear" aria-label="Clear search" onClick={clear}>×</button>}
    </span>
  </label>;
}

// In-page tab row for merged content. `was` renders the retired page name in muted text so a user
// who knew the old IA can still find it (brief §2.1).
// A tab may carry {count, tone}. Tone is SEVERITY, not decoration, and it is the reason the badge
// belongs on the tab rather than only on the rail: one red count in the sidebar tells you the Mint
// page has a problem, but not which of its four screens owns it. Owner's rule, 2026-08-19.
//   bad  red    -- something failed
//   wn   amber  -- something missed its window
//   nu   grey   -- something is stopped on purpose
// `tag` is a plain qualifier rendered in the same muted style WITHOUT the "was" prefix --
// history.html's "Security log owner only" marker, where the point is a permission boundary,
// not a rename.
export function SubTabs({tabs=[],active,onChange,label='Sections',badges={}}){
  return <div className="subtabs" role="tablist" aria-label={label}>
    {tabs.map(tab=>{
      const badge=badges[tab.id];
      return <button key={tab.id} type="button" role="tab" aria-selected={active===tab.id}
        className={active===tab.id?'on':undefined} onClick={()=>onChange(tab.id)}>
        <span>{tab.label}</span>{tab.was&&<span className="was">was {tab.was}</span>}
        {tab.tag&&<span className="was">{' '}{tab.tag}</span>}
        {badge&&badge.count>0&&<span className={`cnt sub${badge.tone==='bad'?' hot':badge.tone==='wn'?' warn':''}`}
          aria-label={`${badge.count} ${badge.tone==='bad'?'failing':'needing attention'}`}>
          {badge.count}</span>}
      </button>;
    })}
  </div>;
}

// Decorative trend only -- no axes, no labels, no tooltip. If a value needs to be READ it is not a
// sparkline, it is a chart. Hidden from assistive tech for exactly that reason.
export function Sparkline({points=[],tone='accent',width=100,height=30}){
  if(!Array.isArray(points)||points.length<2)return null;
  const min=Math.min(...points);
  const max=Math.max(...points);
  const span=(max-min)||1;
  const path=points.map((point,index)=>`${(index/(points.length-1))*width} ${height-((point-min)/span)*height}`).join(' L ');
  return <svg className={`spark spark-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={`M ${path}`} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

// 3px bar for anything with a ceiling. Guards max<=0 so a missing ceiling renders empty rather
// than NaN%, and clamps so an over-budget value pins at full instead of overflowing its trough.
export function Meter({value=0,max=1,warn}){
  const ratio=Number(max)>0?Number(value)/Number(max):0;
  const percent=Math.min(100,Math.max(0,ratio*100));
  const warned=warn!==undefined&&warn!==null&&Number(value)>=Number(warn);
  return <div className={`meter${warned?' meter-warn':''}`} role="progressbar"
    aria-valuenow={Number(value)} aria-valuemin={0} aria-valuemax={Number(max)}>
    <i style={{width:`${percent}%`}}/>
  </div>;
}

// Bounded numeric entry (brief §5). The quick buttons ASSIST the input, they never replace it:
// typing updates which button reads as active, clicking a button fills the input. Mobile layout
// puts the input on its own full-width row with the buttons in a flex row beneath -- they must
// not share a row, which is the current defect on the Minting page.
export function NumberField({label,value='',onChange,min=1,max=100,quick,placeholder,name,id}){
  const ceiling=Number(max)||100;
  const options=(quick&&quick.length?quick:[1,2,5,ceiling])
    .filter(option=>option>=Number(min)&&option<=ceiling)
    .filter((option,index,all)=>all.indexOf(option)===index);
  return <div className="numfield">
    <label className="numfield-label">{label}
      <input type="number" id={id} name={name} min={min} max={ceiling} value={value}
        placeholder={placeholder||`Enter a number (${min}–${ceiling})`}
        onChange={event=>onChange(event.target.value)}/>
    </label>
    {options.length>0&&<div className="numfield-quick">
      {options.map(option=><button key={option} type="button"
        className={`small${String(value)===String(option)?' active':''}`}
        onClick={()=>onChange(String(option))}>{option===ceiling?`Max ${option}`:option}</button>)}
    </div>}
  </div>;
}

// Rate-limit countdown for the 429 surfaces (login, key export, security password).
//
// CAVEAT, and it is a real one: the server sends Retry-After as a HEADER, and api() throws an
// Error carrying only .status and .code -- it never reads response.headers. Surfacing the true
// value needs a one-line change in api(), which Phase 2 is explicitly forbidden from touching.
// So start() takes the seconds if a caller can supply them and otherwise falls back to 60, and
// the moment api() does expose the header this works unchanged.
export function useRetryAfter(fallbackSeconds=60){
  const [seconds,setSeconds]=useState(0);
  useEffect(()=>{
    if(seconds<=0)return undefined;
    const timer=setTimeout(()=>setSeconds(current=>current-1),1000);
    return()=>clearTimeout(timer);
  },[seconds]);
  const start=useCallback(retryAfter=>{
    const parsed=Number(retryAfter);
    setSeconds(Number.isFinite(parsed)&&parsed>0?Math.ceil(parsed):fallbackSeconds);
  },[fallbackSeconds]);
  return {seconds,blocked:seconds>0,start};
}
