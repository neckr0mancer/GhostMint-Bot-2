/* global clearInterval, clearTimeout, CustomEvent, FormData, localStorage, setInterval, setTimeout, URLSearchParams */
import React,{useCallback,useEffect,useRef,useState} from 'react';
import Admin from './Admin.jsx';
import {shortAddress} from './dashboardWidgets/homeParts.jsx';
import {loadError} from './shared.jsx';
import {ACTIVITY_EVENTS,api,Ledger,NumberField,SectionCard,confirmDialog,ConfirmHost,consumePendingMintPrefill,CopyButton,csrf,downloadFile,Empty,EVM_CHAINS,Field,Form,getNotificationLog,notify,Notice,PageTitle,Pager,promptDialog,relativeTime,Select,Skeleton,StatusPill,SubTabs,subscribeNotificationLog,ToastHost,useLoad,useLiveSocket,setPendingMintPrefill,quantityPicks} from './shared.jsx';
import Dashboard from './Dashboard.jsx';
// Phase 4, unit 1 of 5 (brief §2). The 11->5 merge lands one page at a time so any single merge
// can be reverted alone. Mint = Minting + Tasks is done; Automation, Wallets+P&L and History are
// still their own pages and stay fully routable until their own unit lands, so nothing is ever
// unreachable mid-migration.
// Order, labels and grouping are the prototype's, not the old app's: Operate holds the five
// places you work, the footer holds the three account-level ones.
const PAGES=['Home','Mint','Automation','Wallets','History','Settings','Account'];
// Plain History API routing (no router dependency): each page maps to a real /dashboard/<slug>
// URL so a reload lands back where you were instead of always resetting to Dashboard. The server
// already serves index.html for every /dashboard/* path (src/server.js), so this needs no backend
// route changes.
const PAGE_SLUGS={Home:'',Mint:'mint',Automation:'automation',Wallets:'wallets',History:'history',Settings:'settings',Account:'account'};
const SLUG_PAGES=Object.fromEntries(Object.entries(PAGE_SLUGS).map(([page,slug])=>[slug,page]));
// A bookmark that worked yesterday works tomorrow (brief §2, "Non-negotiable on routing"). A
// retired slug resolves to its new page WITH the right sub-tab pre-selected, so /dashboard/tasks
// lands on Mint's Schedule tab rather than dumping the user on Mint now and making them hunt for
// what moved. The URL is rewritten rather than left showing the dead slug, so what gets
// re-bookmarked is the new location.
const RETIRED_SLUGS={
  minting:{page:'Mint',tab:'now'},
  tasks:{page:'Mint',tab:'schedule'},
  snipers:{page:'Automation',tab:'snipers'},
  'watch-rules':{page:'Automation',tab:'social'},
  'target-policies':{page:'Automation',tab:'policies'},
  pnl:{page:'Wallets',tab:'performance'},
  activity:{page:'History',tab:'activity'},
};
// The same redirect, for in-app go() calls rather than URLs. ~14 call sites across the four
// legacy theme widget packs, the mobile FAB and Home still say go('Minting') / go('Tasks') --
// with those names gone from PAGE_SLUGS and VIEWS, each would have produced /dashboard/undefined
// and a blank page. Aliasing inside go() fixes every one of them at a single point INCLUDING the
// three secondary theme packs, which brief §9.1-D15 says to carry unmodified. Each later merge
// unit adds its own aliases here rather than editing call sites it does not otherwise own.
const PAGE_ALIASES={
  Minting:{page:'Mint',tab:'now'},Tasks:{page:'Mint',tab:'schedule'},
  Snipers:{page:'Automation',tab:'snipers'},'Watch Rules':{page:'Automation',tab:'social'},
  'Target Policies':{page:'Automation',tab:'policies'},'P&L':{page:'Wallets',tab:'performance'},Activity:{page:'History',tab:'activity'},
};
// The sub-tab lives in ?tab= rather than a path segment: it is view state within one page, and a
// query param keeps SLUG_PAGES a flat one-level map instead of needing nested route parsing.
function pageFromLocation(){
  const path=window.location.pathname.replace(/^\/dashboard\/?/,'').replace(/\/+$/,'');
  const query=new URLSearchParams(window.location.search);
  const tab=query.get('tab')||null;
  const target=query.get('target')||null;
  // Deep links carry an id as a second segment (/dashboard/target-policies/:id). Split it off so
  // the slug still resolves, and carry the id through as ?target= so the bookmark keeps working
  // rather than 404ing into Dashboard (brief §2, "including deep links").
  const [segment,deepId]=path.split('/');
  const retired=RETIRED_SLUGS[segment];
  if(retired)return {page:retired.page,tab:retired.tab,target:deepId||target,redirected:true};
  return {page:SLUG_PAGES[segment]||'Home',tab,target,redirected:false};
}
function pathFor(page,tab,target){
  const query=new URLSearchParams();
  if(tab)query.set('tab',tab);
  if(target)query.set('target',target);
  const search=query.toString();
  return `/dashboard/${PAGE_SLUGS[page]}${search?`?${search}`:''}`;
}
// The collapsible rail's expanded/collapsed state is a standing layout preference (like an editor's
// sidebar), not per-session UI state -- persisted in localStorage so it survives a reload, shared
// between the regular dashboard and the admin shell since it's visually the same rail.
const RAIL_EXPANDED_KEY='ghostmint-rail-expanded';
// Pinned expanded while the design is being matched to the prototype. The collapsed rail is a
// second layout that would have to be kept identical too, and it is not the state the prototype
// shows. Restore the stored preference once the expanded rail matches.
function readRailExpanded(){return true;}
function writeRailExpanded(value){try{localStorage.setItem(RAIL_EXPANDED_KEY,String(value));}catch{/* private browsing or storage disabled -- falls back to session-only */}}
const RAIL_THEMES=new Set(['ghost-mint','ghost-mint-light']);
const THEME_OPTIONS=[{value:'ghost-mint',label:'Ghost Mint'},{value:'ghost-mint-light',label:'Ghost Mint Light'},{value:'clean-vault',label:'Clean Vault'},{value:'neon-arcade',label:'Neon Arcade'},{value:'quiet-ledger',label:'Quiet Ledger'}];
const CHAIN_META={
  ethereum:{label:'Ethereum',icon:<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 5 12.5 12 16.5 19 12.5z" fill="#8ea8ff" opacity=".55"/><path d="M12 17.75 5 13.75 12 22 19 13.75z" fill="#8ea8ff"/></svg>},
  base:{label:'Base',icon:<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#5b8def"/></svg>},
  arbitrum:{label:'Arbitrum',icon:<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3 4 20h5l3-7 3 7h5z" fill="#28a0f0"/></svg>},
  polygon:{label:'Polygon',icon:<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 21 7v10l-9 5-9-5V7z" fill="#c084fc"/></svg>},
  robinhood:{label:'Robinhood Chain',icon:<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="6" fill="#00C805"/></svg>},
};
function chainMeta(value){return CHAIN_META[value]||{label:value,icon:null};}
const CHAIN_CHEVRON_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>;
const CHAIN_CHECK_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>;
const SOLANA_ICON=<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 20 7v10l-8 5-8-5V7z" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>;
const BOLT_PATH="M13 2 4 14h6l-1 8 9-12h-6z";
const ICON_PROPS={viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",xmlns:"http://www.w3.org/2000/svg"};
const NAV_ICONS={
  Home:<svg {...ICON_PROPS}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>,
  Wallets:<svg {...ICON_PROPS}><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1" fill="currentColor" stroke="none"/></svg>,
  Mint:<svg {...ICON_PROPS}><path d={BOLT_PATH}/></svg>,
  Tasks:<svg {...ICON_PROPS}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>,
  Automation:<svg {...ICON_PROPS}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>,
  Snipers:<svg {...ICON_PROPS}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>,
  'Watch Rules':<svg {...ICON_PROPS}><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>,
  'Target Policies':<svg {...ICON_PROPS}><path d="M12 2 4 5v6c0 5 3.4 8.7 8 9 4.6-.3 8-4 8-9V5z"/></svg>,
  History:<svg {...ICON_PROPS}><path d="M2 12h4l2 7 4-14 2 7h8"/></svg>,
  Activity:<svg {...ICON_PROPS}><path d="M2 12h4l2 7 4-14 2 7h8"/></svg>,
  'P&L':<svg {...ICON_PROPS}><path d="M5 19v-6M12 19V8M19 19v-10"/></svg>,
  Settings:<svg {...ICON_PROPS}><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M4.5 7.5l2.2 1.3M17.3 15.2l2.2 1.3M3 12h2.5M18.5 12H21M4.5 16.5l2.2-1.3M17.3 8.8l2.2-1.3"/></svg>,
  Account:<svg {...ICON_PROPS}><circle cx="12" cy="8.5" r="3.2"/><path d="M5 20c1.2-3.5 4-5.2 7-5.2s5.8 1.7 7 5.2"/></svg>,
  Admin:<svg {...ICON_PROPS}><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M4.5 7.5l2.2 1.3M17.3 15.2l2.2 1.3M3 12h2.5M18.5 12H21M4.5 16.5l2.2-1.3M17.3 8.8l2.2-1.3"/></svg>,
};
/* ── Ported shell chrome (docs/prototype-pages/_rail.html) ────────────────────────────────────
   These are the prototype's own icons, copied path-for-path, at its stroke-width of 1.9 and under
   its .ico class. They are deliberately NOT reused from NAV_ICONS above: that set is drawn at 1.8
   inside a filled .nav-icon badge, which is the look this pass replaces. NAV_ICONS stays because
   the admin shell, the bottom bar and the More sheet still render it. */
const RAIL_ICON_PROPS={className:"ico",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.9",strokeLinecap:"round",strokeLinejoin:"round",xmlns:"http://www.w3.org/2000/svg"};
const RAIL_ICONS={
  Home:<svg {...RAIL_ICON_PROPS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V20h14V9.8"/></svg>,
  Mint:<svg {...RAIL_ICON_PROPS}><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z"/></svg>,
  Automation:<svg {...RAIL_ICON_PROPS}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>,
  Wallets:<svg {...RAIL_ICON_PROPS}><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16.5 14.5h.01"/></svg>,
  History:<svg {...RAIL_ICON_PROPS}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>,
  Admin:<svg {...RAIL_ICON_PROPS}><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/></svg>,
  Account:<svg {...RAIL_ICON_PROPS}><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/></svg>,
  Settings:<svg {...RAIL_ICON_PROPS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14.1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.9 3H10a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/></svg>,
};
const CMDK_ICON=<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
// prototype.css expresses "mobile" as .app[data-m], set by the prototype's own Desktop/Mobile
// harness toggle rather than by a media query, so the real app has to supply the attribute. 700px
// is this app's existing mobile breakpoint -- the one .mobile-bottombar and .more-sheet already
// use -- so the rail, the bottom bar and the sheet all still change over on the same line.
const MOBILE_QUERY="(max-width:700px)";
function useIsMobile(){
  const [mobile,setMobile]=useState(()=>typeof window!=="undefined"&&window.matchMedia(MOBILE_QUERY).matches);
  useEffect(()=>{
    const mq=window.matchMedia(MOBILE_QUERY);
    const onChange=event=>setMobile(event.matches);
    mq.addEventListener("change",onChange);
    setMobile(mq.matches);
    return()=>mq.removeEventListener("change",onChange);
  },[]);
  return mobile;
}
function ChainSelect({name,label,options,value,onChange}){const [open,setOpen]=useState(false);const [activeIndex,setActiveIndex]=useState(0);const rootRef=useRef(null);const panelRef=useRef(null);const meta=chainMeta(value);const evmOptions=(options||[]).filter(option=>EVM_CHAINS.includes(option));useEffect(()=>{if(!open)return;function onDocClick(event){if(rootRef.current&&!rootRef.current.contains(event.target))setOpen(false);}function onKey(event){if(event.key==='Escape')setOpen(false);}document.addEventListener('mousedown',onDocClick);document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('mousedown',onDocClick);document.removeEventListener('keydown',onKey);};},[open]);useEffect(()=>{if(open)panelRef.current?.focus();},[open]);function choose(next){onChange({target:{name,value:next}});setOpen(false);}function openList(){setActiveIndex(Math.max(0,evmOptions.indexOf(value)));setOpen(true);}function onTriggerKeyDown(event){if(event.key==='ArrowDown'||event.key==='Enter'||event.key===' '){event.preventDefault();openList();}}function onListKeyDown(event){if(event.key==='ArrowDown'){event.preventDefault();setActiveIndex(index=>Math.min(evmOptions.length-1,index+1));}else if(event.key==='ArrowUp'){event.preventDefault();setActiveIndex(index=>Math.max(0,index-1));}else if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(evmOptions[activeIndex]);}else if(event.key==='Escape'){event.preventDefault();setOpen(false);}else if(event.key==='Tab'){setOpen(false);}}return <div className="chain-select">{label}<div className="chain-select-control" ref={rootRef}><input type="hidden" name={name} value={value}/><button type="button" className="chain-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={()=>open?setOpen(false):openList()} onKeyDown={onTriggerKeyDown}><span className="chain-icon" aria-hidden="true">{meta.icon}</span><span className="chain-select-value">{meta.label}</span>{meta.testnet&&<span className="chain-select-tag">Testnet</span>}<span className="chain-select-chevron" aria-hidden="true">{CHAIN_CHEVRON_ICON}</span></button>{open&&<ul className="chain-select-panel" role="listbox" aria-label={label} tabIndex="-1" ref={panelRef} onKeyDown={onListKeyDown}><li className="chain-select-group-label" role="presentation">EVM</li>{evmOptions.map((option,index)=>{const optionMeta=chainMeta(option);return <li key={option} role="option" aria-selected={option===value} className={`chain-select-option${option===value?' selected':''}${index===activeIndex?' active':''}`} onMouseEnter={()=>setActiveIndex(index)} onClick={()=>choose(option)}><span className="chain-icon" aria-hidden="true">{optionMeta.icon}</span><span>{optionMeta.label}</span><span className="chain-select-option-end">{optionMeta.testnet&&<span className="chain-select-tag">Testnet</span>}{option===value&&<span className="chain-select-option-check" aria-hidden="true">{CHAIN_CHECK_ICON}</span>}</span></li>;})}<li className="chain-select-group-label" role="presentation">Other networks</li><li className="chain-select-option disabled" role="option" aria-disabled="true" aria-selected="false"><span className="chain-icon" aria-hidden="true">{SOLANA_ICON}</span><span>Solana</span><span className="chain-select-option-end"><span className="chain-select-tag">Coming soon</span></span></li></ul>}</div></div>;}
// Wallet create/import only need to distinguish the chain family (EVM vs Solana), not a specific
// EVM chain -- one address already works on every EVM chain, so wallets store DEFAULT_EVM_CHAIN
// as their nominal home chain and the actual target chain is resolved per-mint instead.
const DEFAULT_EVM_CHAIN='ethereum';
const CHAIN_FAMILIES=[{value:'evm',label:'EVM',icon:CHAIN_META.ethereum.icon},{value:'solana',label:'Solana',icon:SOLANA_ICON,disabled:true}];
function WalletChainSelect({name,label,value,onChange}){const [open,setOpen]=useState(false);const rootRef=useRef(null);const panelRef=useRef(null);const current=CHAIN_FAMILIES.find(family=>family.value===value)||CHAIN_FAMILIES[0];useEffect(()=>{if(!open)return;function onDocClick(event){if(rootRef.current&&!rootRef.current.contains(event.target))setOpen(false);}function onKey(event){if(event.key==='Escape')setOpen(false);}document.addEventListener('mousedown',onDocClick);document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('mousedown',onDocClick);document.removeEventListener('keydown',onKey);};},[open]);useEffect(()=>{if(open)panelRef.current?.focus();},[open]);function choose(next){onChange({target:{name,value:next}});setOpen(false);}return <div className="chain-select">{label}<div className="chain-select-control" ref={rootRef}><input type="hidden" name={name} value={current.value==='evm'?DEFAULT_EVM_CHAIN:''}/><button type="button" className="chain-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={()=>setOpen(value=>!value)}><span className="chain-icon" aria-hidden="true">{current.icon}</span><span className="chain-select-value">{current.label}</span><span className="chain-select-chevron" aria-hidden="true">{CHAIN_CHEVRON_ICON}</span></button>{open&&<ul className="chain-select-panel" role="listbox" aria-label={label} tabIndex="-1" ref={panelRef}>{CHAIN_FAMILIES.map(family=><li key={family.value} role="option" aria-disabled={family.disabled||undefined} aria-selected={family.value===current.value} className={`chain-select-option${family.value===current.value?' selected':''}${family.disabled?' disabled':''}`} onClick={()=>!family.disabled&&choose(family.value)}><span className="chain-icon" aria-hidden="true">{family.icon}</span><span>{family.label}</span><span className="chain-select-option-end">{family.disabled&&<span className="chain-select-tag">Coming soon</span>}{family.value===current.value&&<span className="chain-select-option-check" aria-hidden="true">{CHAIN_CHECK_ICON}</span>}</span></li>)}</ul>}</div></div>;}
// Sets or changes the one account password that gates every sensitive dashboard action (currently:
// exporting a wallet's keystore, which it also doubles as the keystore's own encryption password
// for -- see Wallets' exportKey below). Shared by Wallets (first-time-set, triggered on demand by
// exportKey) and the Account page's own standing "change" control, so there is exactly one place
// this flow is implemented.
async function promptSetSecurityPassword({isChange,onProfileChange}){
  let currentPassword;
  if(isChange){
    currentPassword=await promptDialog('Enter your current security password.',{placeholder:'Current security password',masked:true});
    if(!currentPassword)return false;
  }
  const newPassword=await promptDialog(isChange
    ?'Choose a new security password (at least 12 characters).'
    :'Set a security password (at least 12 characters). It will be required for this and every future sensitive action, like exporting a wallet key. Write it down -- it cannot be recovered if lost.',
    {placeholder:'At least 12 characters',masked:true});
  if(!newPassword)return false;
  const confirmed=await promptDialog('Confirm the security password.',{placeholder:'Re-enter the password',masked:true});
  if(newPassword!==confirmed){notify('Passwords did not match.',{type:'error'});return false;}
  try{
    await api('/api/auth/security-password',{method:'PUT',body:JSON.stringify({currentPassword,newPassword})});
    onProfileChange?.(current=>({...current,securityPasswordSet:true}));
    notify(isChange?'Security password changed.':'Security password set.',{type:'success'});
    return true;
  }catch(value){notify(value.message,{type:'error'});return false;}
}
// Module-level so both the Holdings tab's per-wallet action and the Export tab share ONE
// implementation. Two copies of a key-export flow is exactly the kind of divergence that ends
// with one of them missing a confirmation step.
//
// The server never returns a raw private key to the browser -- it re-encrypts the stored key
// server-side into a standard V3 keystore, encrypted under the account's own security password
// (set once via promptSetSecurityPassword, reused for every export) rather than a fresh one chosen
// per export, so there is exactly one password to remember for every sensitive action.
async function exportWalletKeystore(label,{profile,onProfileChange}){
  if(!profile.securityPasswordSet){
    if(!await confirmDialog('Exporting a key needs a security password first. It will then be required for this and every future sensitive action. Set it now?'))return;
    if(!await promptSetSecurityPassword({isChange:false,onProfileChange}))return;
  }
  if(!await confirmDialog(`Export the encrypted keystore for ${label}? Your security password will encrypt it.`))return;
  const securityPassword=await promptDialog('Enter your security password.',{placeholder:'Security password',masked:true});
  if(!securityPassword)return;
  try{
    const {keystore}=await api(`/api/wallets/${encodeURIComponent(label)}/export`,{method:'POST',body:JSON.stringify({securityPassword,confirmation:'CONFIRM'})});
    downloadFile(`${label}-keystore.json`,keystore);
    notify('Encrypted keystore downloaded. Store it and your security password separately and securely.',{type:'success'});
  }catch(value){notify(value.message,{type:'error'});}
}
function Wallets({profile,onProfileChange}){const walletList=useLoad('/api/wallets',[],'wallets.changed');const {data:wallets,load}=walletList;const [createChain,setCreateChain]=useState('evm');const [importChain,setImportChain]=useState('evm');const [importMethod,setImportMethod]=useState('privateKey');const [query,setQuery]=useState('');async function submit(event,path){event.preventDefault();const form=event.currentTarget;const values=Object.fromEntries(new FormData(form));try{await api(path,{method:'POST',body:JSON.stringify(values)});form.reset();notify('Wallet saved securely.',{type:'success'});load();}catch(value){notify(value.message,{type:'error'});}}async function remove(label){if(!await confirmDialog(`Remove wallet ${label}? This cannot be undone.`))return;try{await api(`/api/wallets/${encodeURIComponent(label)}`,{method:'DELETE',body:JSON.stringify({confirmation:'CONFIRM'})});load();}catch(value){notify(value.message,{type:'error'});}}
  const exportKey=label=>exportWalletKeystore(label,{profile,onProfileChange});
  const normalized=query.trim().toLowerCase();const filtered=wallets?(normalized?wallets.filter(wallet=>[wallet.label,wallet.address,wallet.chain].filter(Boolean).some(value=>String(value).toLowerCase().includes(normalized))):wallets):[];return <><p className="page-lead">Create server-side encrypted wallets, check balances, and manage imports.</p><Notice error={loadError(walletList,'Could not load wallets.')}/><div className="page-toolbar"><label className="page-search">Find a wallet<input type="search" value={query} placeholder="Label, address, chain…" onChange={e=>setQuery(e.target.value)}/></label></div>{wallets===null?<Skeleton/>:<div className="card-grid wallet-grid">{filtered.map(wallet=><article className="card" key={wallet.label}><div><span className="pill">{wallet.chain}</span><h2>{wallet.label}</h2></div><div className="user-card-identity"><code>{wallet.address}</code><CopyButton value={wallet.address} label="Copy wallet address"/></div><div className="wallet-balances">{wallet.balances?.length?wallet.balances.map(b=><div className="wallet-balance-row" key={b.chain}><span>{chainMeta(b.chain).label}</span><strong>{b.balance??'Unavailable'} {b.symbol}</strong></div>):<div className="wallet-balance-row">Unavailable</div>}</div><div className="br"><button className="b g sm" onClick={()=>exportKey(wallet.label)}>Export key</button><button className="b d sm" onClick={()=>remove(wallet.label)}>Remove</button></div></article>)}{filtered.length===0&&<Empty text={normalized?'No wallets match this search.':'No wallets yet. Create the recommended server-side wallet below.'}/>}</div>}<div className="form-grid wallet-forms"><Form className="form-wallet-create" title="Create wallet" note="Recommended - the private key is generated, encrypted, and never returned." onSubmit={e=>submit(e,'/api/wallets/create')}><Field name="label" label="Label" placeholder="$1 and a dream"/><WalletChainSelect name="chain" label="Chain" value={createChain} onChange={e=>setCreateChain(e.target.value)}/><button className="b p">Create securely</button></Form><Form className="form-wallet-import" title="Import wallet" warning="Not recommended: your key or seed phrase crosses browser memory and network transit. Use HTTPS; it is encrypted immediately and never returned." onSubmit={e=>submit(e,'/api/wallets/import')}><Field name="label" label="Label" placeholder="$1 and a dream"/><WalletChainSelect name="chain" label="Chain" value={importChain} onChange={e=>setImportChain(e.target.value)}/><div className="method-toggle"><span>Import using</span><div className="seg" role="radiogroup" aria-label="Import method"><button type="button" aria-pressed={importMethod==='privateKey'} className={importMethod==='privateKey'?'on':undefined} onClick={()=>setImportMethod('privateKey')}>Private key</button><button type="button" aria-pressed={importMethod==='seedPhrase'} className={importMethod==='seedPhrase'?'on':undefined} onClick={()=>setImportMethod('seedPhrase')}>Seed phrase</button></div></div><input type="hidden" name="importMethod" value={importMethod}/>{importMethod==='privateKey'?<Field name="privateKey" label="Private key" type="password" autoComplete="off"/>:<label>Seed phrase (12-24 words)<textarea className="compact" name="seedPhrase" required autoComplete="off" placeholder="witch collapse practice feed shame open despair creek road again ice least"/></label>}<button className="b g">Import over HTTPS</button></Form></div></>}
const SEADROP_SIGNATURE='mintPublic(address,address,address,uint256)';
const ADDRESS_SHAPE=/^0x[0-9a-fA-F]{40}$/;
function weiToEthDisplay(wei){
  try{
    const value=BigInt(wei);
    const negative=value<0n;
    const abs=negative?-value:value;
    const whole=abs/10n**18n;
    const frac=(abs%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');
    return `${negative?'-':''}${whole}${frac?`.${frac}`:''}`;
  }catch{return wei;}
}
// Parses a plain decimal ETH string into a wei BigInt without needing ethers on the frontend.
// Returns null for anything that isn't a non-negative plain decimal (including negatives -- the
// regex only matches unsigned numbers) or that asks for more precision than wei has (>18 places),
// so the caller can reject bad input instead of silently sending a wrong or garbled amount.
function ethToWei(eth){
  const trimmed=String(eth??'').trim();
  if(!trimmed)return 0n;
  const match=/^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if(!match)return null;
  const [,whole,frac='']=match;
  if(frac.length>18)return null;
  return BigInt(whole)*10n**18n+BigInt(frac.padEnd(18,'0')||'0');
}
// One auto-detect covers everything a mint needs -- which chain the contract lives on, whether it's
// a plain mint(uint256) contract or a SeaDrop drop (which calls a different contract entirely, see
// seaDropCall.js), and the price -- instead of asking the user to know or manually enter any of
// that themselves. There is deliberately no manual "Detect" button: pasting a contract address and
// tabbing away is enough, and changing the quantity re-runs it the same way (see
// handleAutoDetectBlur).
const CONTRACT_ICON=<svg {...ICON_PROPS}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>;
const LEDGER_ICON=<svg {...ICON_PROPS}><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>;
const INFO_ICON=<svg {...ICON_PROPS}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>;
// The prototype's own glyphs, copied path-for-path from docs/prototype-pages/mint.html so the
// notices, field errors and the preview header carry the same marks as the design.
const WARN_TRIANGLE_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>;
const ALERT_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>;
const BATCH_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
const CLOCK_ICON=<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
// Schedule-row glyphs, copied from docs/prototype-pages/mint.html:134-140: a clock for a
// scheduled row, pause bars for a paused one, and a cross (tinted --loss-text at the call site)
// for a failed one. CLOCK_ICON_LG is the 24px .ri/.chip-ico variant; CLOCK_ICON above is the 13px
// one the .tokbar uses.
const CLOCK_ICON_LG=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
const PAUSE_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>;
// Empty-state glyphs, from the prototype: a nested square for "No presets saved"
// (mint.html:215) and a wallet for "No wallets to batch" (mint.html:192).
const PRESET_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 5h14v14H5z"/><path d="M9 9h6v6H9z"/></svg>;
const WALLET_EMPTY_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="6" width="18" height="13" rx="2.5"/></svg>;
const CROSS_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M18 6 6 18M6 6l12 12"/></svg>;
const LOCK_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>;
function shortHex(value){const v=String(value||"");return v.length>12?`${v.slice(0,6)}…${v.slice(-4)}`:v;}
function Minting({onSwitchToBatch,onGoWallets}){const wallets=useLoad('/api/wallets',[],'wallets.changed');const limits=useLoad('/api/profile/limits');const [preview,setPreview]=useState(null);const [confirmResults,setConfirmResults]=useState(null);const formRef=useRef(null);const previewRef=useRef(null);const [walletLabel,setWalletLabel]=useState('');const [contractAddress,setContractAddress]=useState('');const [quantity,setQuantity]=useState('1');const [methodSignature,setMethodSignature]=useState('');const [argumentsJson,setArgumentsJson]=useState('');const [priceEth,setPriceEth]=useState('');const [seaDropAddress,setSeaDropAddress]=useState('');const [detectedChain,setDetectedChain]=useState('');const [maxPerWallet,setMaxPerWallet]=useState(null);const [detecting,setDetecting]=useState(false);const lastDetected=useRef('');
  // Simulation is no longer user-triggered (backlog §7.2): the prototype has no "Validate and
  // simulate" control, only a Re-simulate on an expired quote, so the first simulation runs on its
  // own. Debounced, because otherwise typing an address would fire one /api/mints/preview per
  // keystroke and each call issues a 300s preview token.
  const [simulating,setSimulating]=useState(false);
  const [mintError,setMintError]=useState(null);
  const [quantityIssue,setQuantityIssue]=useState(null);
  const simulateTimer=useRef(null);
  useEffect(()=>{if(!walletLabel&&wallets.data?.length)setWalletLabel(wallets.data[0].label);},[wallets.data]);
  // Picks up whatever Quick Mint already had typed in (see Dashboard.jsx's goToFullMint) so landing
  // here isn't a dead end with an empty contract field -- detects immediately rather than waiting
  // for a blur that will never come since the field already has focus-losing content in it.
  useEffect(()=>{
    const prefill=consumePendingMintPrefill();
    if(!prefill)return;
    if(prefill.walletLabel)setWalletLabel(prefill.walletLabel);
    if(prefill.quantity)setQuantity(prefill.quantity);
    if(prefill.contractAddress){setContractAddress(prefill.contractAddress);detect(prefill.contractAddress,prefill.quantity);}
  },[]);
  async function detect(addressOverride,quantityOverride){
    const trimmed=(addressOverride??contractAddress).trim();
    const effectiveQuantity=quantityOverride??quantity;
    if(!trimmed){notify('Enter a contract address first.',{type:'error'});return;}
    setDetecting(true);
    try{
      const result=await api(`/api/mints/detect?contractAddress=${encodeURIComponent(trimmed)}&quantity=${encodeURIComponent(effectiveQuantity)}`);
      lastDetected.current=`${trimmed}:${effectiveQuantity}`;
      setMethodSignature(result.methodSignature);
      setArgumentsJson(JSON.stringify(result.arguments));
      setSeaDropAddress(result.seaDropAddress||'');
      // The chain a mint actually targets comes from where the contract was found, never from the
      // wallet -- a wallet's stored chain is just its nominal home chain, not a restriction (see
      // DEFAULT_EVM_CHAIN). Without this, submitting fell back to that nominal chain and could
      // silently try to broadcast on the wrong network entirely.
      setDetectedChain(result.chain);
      setMaxPerWallet(result.maxPerWallet||null);
      // A quantity already typed in before detection finished can be higher than the contract's
      // real per-wallet cap -- pull it back down rather than leaving an already-invalid value sitting
      // in the field.
      if(result.maxPerWallet&&Number(effectiveQuantity)>result.maxPerWallet)setQuantity(String(result.maxPerWallet));
      const label=result.isSeaDrop?'SeaDrop drop':'contract';
      // The field is edited in ETH (result.valueWei comes back from the API in wei); converted at
      // the two boundaries -- here on the way in, and in inspect() on the way out -- so wei never
      // has to be typed by hand. It stays a required field even though it now lives inside the
      // collapsed Advanced section -- an unknown price forces that section open so the user isn't
      // stuck facing a required-but-hidden field, rather than quietly clearing it to something that
      // reads as optional (see the "never let an unresolved price look free" note this mirrors).
      if(result.priceKnown){setPriceEth(weiToEthDisplay(result.valueWei));notify(`Detected ${label} on ${result.chain} — price read from the contract.`,{type:'success'});}
      else{setPriceEth('');notify(`Detected ${label} on ${result.chain}, but this contract doesn't expose a recognized price function. Enter the price per NFT in ETH below — enter 0 if it's free.`,{type:'info'});}
    }catch(value){notify(value.message,{type:'error'});}
    finally{setDetecting(false);}
  }
  // No manual "Detect" button anywhere -- detection runs itself the moment a full, valid-shaped
  // address is present (on every keystroke while typing, and critically also on paste, which never
  // fires a blur event the way tabbing/clicking away does -- waiting only for blur left a pasted
  // address sitting in the field with detection never having started). Takes the just-changed value
  // directly rather than reading state, since setState hasn't applied yet inside the same handler.
  // Quantity changes re-trigger it too (quantity affects both the price and the call arguments).
  function autoDetectIfReady(value=contractAddress,quantityValue=quantity){const trimmed=value.trim();if(ADDRESS_SHAPE.test(trimmed)&&`${trimmed}:${quantityValue}`!==lastDetected.current)detect(trimmed,quantityValue);}
  function handleAutoDetectBlur(){autoDetectIfReady();}
  function resetDetectedFields(){setContractAddress('');setQuantity('1');setMethodSignature('');setArgumentsJson('');setPriceEth('0');setSeaDropAddress('');setDetectedChain('');setMaxPerWallet(null);lastDetected.current='';}
  // Auto-simulate driver (backlog §7.2). Fires 600ms after the inputs settle, and only when the
  // form could actually produce a preview: a detected contract, a chosen wallet, a quantity.
  // Clears any previous quote first so a stale total can never sit under fresh inputs.
  useEffect(()=>{
    clearTimeout(simulateTimer.current);
    if(!methodSignature||!walletLabel||!quantity||detecting)return;
    simulateTimer.current=setTimeout(()=>{inspect();},600);
    return()=>clearTimeout(simulateTimer.current);
  },[methodSignature,argumentsJson,seaDropAddress,walletLabel,quantity,priceEth,detectedChain,detecting]);
  useEffect(()=>()=>clearTimeout(simulateTimer.current),[]);
  async function inspect(event){event?.preventDefault?.();const raw={walletLabel,presetName:undefined,contractAddress,methodSignature,seaDropAddress,arguments:argumentsJson,priceEth};try{const valueWei=ethToWei(raw.priceEth);if(valueWei===null){notify('Price (ETH) must be a plain non-negative number -- 0.01 for example, or 0 if the mint is free.',{type:'error'});return;}const batch=raw.walletLabels?.split(/[,\n]+/).map(x=>x.trim()).filter(Boolean);const input={walletLabel:raw.walletLabel,walletLabels:batch?.length?batch:undefined,presetName:raw.presetName||undefined,contractAddress:raw.contractAddress||undefined,methodSignature:raw.methodSignature||undefined,seaDropAddress:raw.seaDropAddress||undefined,arguments:raw.arguments?JSON.parse(raw.arguments):[],valueWei:valueWei.toString(),chain:detectedChain||undefined};setSimulating(true);setMintError(null);setQuantityIssue(null);
    setPreview(await api('/api/mints/preview',{method:'POST',body:JSON.stringify(input)}));setConfirmResults(null);
  }catch(value){
    setPreview(null);
    // A field-scoped validation issue belongs on the field (.in.bad + .fielderr), everything else
    // is a money-surface failure and gets the .notice panel -- never a toast alone.
    const issue=value.issues?.find(entry=>entry.field==='quantity');
    if(issue)setQuantityIssue(issue.message);
    else setMintError({title:value.message||'Could not simulate this mint.',detail:'Nothing was broadcast.',code:value.status,onRetry:()=>inspect()});
  }finally{setSimulating(false);}}
  // Each wallet in the batch is annotated with its own outcome (see confirmResults, rendered per
  // item below) rather than one pass/fail for the whole batch -- a failure on one wallet no longer
  // hides whether the others actually went through.
  async function confirmMint(){if(!await confirmDialog('Broadcast this simulation-backed mint?'))return;try{
    const response=await api('/api/mints/confirm',{method:'POST',body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});
    const succeeded=response.results.filter(entry=>entry.status==='success').length;
    const total=response.results.length;
    if(succeeded===total){notify(total>1?`All ${total} mints submitted.`:'Mint submitted.',{type:'success'});setPreview(null);setConfirmResults(null);formRef.current?.reset();resetDetectedFields();}
    else{setConfirmResults(Object.fromEntries(response.results.map(entry=>[entry.label,entry])));notify(succeeded===0?'Mint failed -- see the reason below.':`${succeeded}/${total} mints submitted -- see details below for the rest.`,{type:succeeded===0?'error':'info'});}
  }catch(value){notify(value.message,{type:'error'});}}
  const detected=Boolean(methodSignature);
  const item=preview?.items?.[0];
  const totalDebitWei=item?item.simulation.estimatedCostWei:null;
  // The prototype's four states for this page, resolved once so every element below reads the
  // same answer. EMPTY is "no wallet exists" -- the prototype shows the form DISABLED in that
  // state rather than hiding it, so you can see what minting looks like before you have one.
  const walletsArrived=wallets.data!==null&&wallets.data!==undefined;
  const noWallets=walletsArrived&&wallets.data.length===0;
  const pageError=wallets.error?{title:'Could not load your wallets.',detail:'Request failed safely — nothing was changed.',code:wallets.status,onRetry:wallets.load}:mintError;
  // Derived from the cap by the shared rule (shared.jsx quantityPicks). At a cap of 3 this
  // returns exactly the prototype's "1 2 3"; at 10 it returns "1 2 5". Backlog §13.
  const maxPick=maxPerWallet||100;
  const quickPicks=quantityPicks(maxPick);
  const ceilingWei=limits.data?.dailySpendingBudgetWei;
  return <>
    {/* Prototype mint.html: a .nt.w banner above the form when no wallet exists. The form stays
        VISIBLE and disabled underneath -- "shown disabled so you can see what minting looks like". */}
    {noWallets&&<div className="nt w" style={{marginBottom:'12px'}}>
      {WARN_TRIANGLE_ICON}
      <div><b>Create a wallet before minting.</b> The form below is shown disabled so you can see what minting looks like.
        <div style={{marginTop:'8px'}}><button type="button" className="b sm" onClick={()=>onGoWallets?.()}>Create a wallet</button></div></div>
    </div>}
    <div className="split">
      <div className="card">
        <div className="ch"><div className="chip-ico">{CONTRACT_ICON}</div><h2>Contract</h2></div>
        <div className="g" style={{gap:'11px'}}>
          <label className="fl"><span>Contract address</span>
            <input className={`in mono${detected?' ok':''}`} disabled={noWallets}
              placeholder="0x… paste a contract address" value={contractAddress}
              onChange={e=>{setContractAddress(e.target.value);autoDetectIfReady(e.target.value,quantity);}}
              onBlur={handleAutoDetectBlur}/>
          </label>
          {/* Detection summary, the prototype's .nt.i one-liner. */}
          {!detecting&&detected&&<div className="nt i">{INFO_ICON}
            <div>Detected <b>{methodSignature===SEADROP_SIGNATURE?'SeaDrop drop':'contract'}</b>
              {detectedChain&&<> · {detectedChain}</>}
              {priceEth&&priceEth!=='0'?<> · {priceEth} ETH</>:<> · free</>}
              {maxPerWallet?<> · max {maxPerWallet}/wallet</>:null}
            </div></div>}
          <div className="g gm2 g2">
            <label className="fl"><span>Wallet</span>
              {/* Grouped exactly as the prototype: an EVM optgroup of real wallets, and a Solana
                  group carrying one disabled option so the roadmap is visible without implying
                  it works. Empty state is a single disabled "No wallets yet". */}
              {noWallets
                ?<select className="in" disabled><option>No wallets yet</option></select>
                :<select className="in" value={walletLabel} disabled={!walletsArrived}
                    onChange={e=>setWalletLabel(e.target.value)}>
                    <optgroup label="EVM">
                      {(wallets.data||[]).map(entry=><option key={entry.label} value={entry.label}>{entry.label}</option>)}
                    </optgroup>
                    <optgroup label="Solana"><option disabled>Solana (not yet supported)</option></optgroup>
                  </select>}
            </label>
            <label className="fl"><span>Quantity{maxPerWallet?<span style={{color:'var(--faint)',fontWeight:500}}> · max {maxPerWallet}</span>:null}</span>
              <div className="qty">
                <input className={`in tab${quantityIssue?' bad':''}`} type="number" min={1} max={maxPerWallet||100}
                  disabled={noWallets} placeholder={`Enter quantity (1–${maxPerWallet||100})`} value={quantity}
                  onChange={e=>{setQuantity(e.target.value);autoDetectIfReady(contractAddress,e.target.value);}}/>
                <div className="qb">
                  {quickPicks.map(pick=><button type="button" key={pick} disabled={noWallets}
                    className={String(pick)===String(quantity)?'on':undefined}
                    onClick={()=>{setQuantity(String(pick));autoDetectIfReady(contractAddress,String(pick));}}>{pick}</button>)}
                  <button type="button" disabled={noWallets}
                    className={String(maxPick)===String(quantity)?'on':undefined}
                    onClick={()=>{setQuantity(String(maxPick));autoDetectIfReady(contractAddress,String(maxPick));}}>Max</button>
                </div>
              </div>
              {/* Server-side validation surfaces as .in.bad + .fielderr, per the prototype's .ox. */}
              {quantityIssue&&<div className="fielderr">{ALERT_ICON}{quantityIssue}</div>}
            </label>
          </div>
          <label className="fl"><span>Price per mint <span style={{color:'var(--faint)',fontWeight:500}}>· auto-detected</span></span>
            <input className="in tab" type="number" step="any" min="0" value={priceEth} disabled={noWallets}
              placeholder={detected?'e.g. 0.08 — leave blank to use detected price':'Detected once a contract is entered'}
              onChange={e=>setPriceEth(e.target.value)}/>
          </label>
          {/* Batch cross-link -- the prototype keeps this on the single-wallet form, where the
              intent actually arises, rather than leaving Batch buried as a sub-tab. */}
          <div className="nt i">{BATCH_ICON}
            <div>Minting from more than one wallet? <b>Batch</b> simulates and submits each wallet independently, so one failure doesn&apos;t cancel the rest.
              <div style={{marginTop:'8px'}}><button type="button" className="b sm" onClick={()=>onSwitchToBatch?.()}>Switch to batch</button></div></div></div>
        </div>
      </div>

      <div className="g">
        {preview&&<PreviewExpiry preview={preview} onExpire={()=>{setPreview(null);notify('That simulation expired before it was confirmed. Nothing was submitted — simulate again.',{type:'error'});}} onResimulate={inspect}/>}
        <div className="sober">
          <div className="sh">{LOCK_ICON}Transaction preview</div>
          {/* Register 1: label left, figure right, tabular numerals. The EMPTY state renders the
              same rows with em dashes and 0.000000 ETH rather than collapsing -- the prototype's
              note is that "a collapsed total is a hidden total". */}
          <table className="led">
            <tbody>
              <tr><td>Contract</td><td className="mono">{item?shortHex(item.preview.contractAddress):'—'}</td></tr>
              <tr><td>Method</td><td className="mono">{item?item.preview.methodSignature:'—'}</td></tr>
              <tr><td>Chain</td><td>{detectedChain||'—'}</td></tr>
              <tr><td>Quantity</td><td>{item?quantity:'—'}</td></tr>
              <tr><td>Mint price</td><td>{item?`${weiToEthDisplay(item.preview.nativeValue)} ETH`:'0.000000 ETH'}</td></tr>
              <tr><td>Est. gas</td><td>{item?`${weiToEthDisplay(item.simulation.estimatedGasCostWei??0)} ETH`:'0.000000 ETH'}</td></tr>
              <tr><td>Simulation</td><td>{simulating?'Running…':item?'Passed':'Not run'}</td></tr>
              <tr className="tot"><td>Total debit</td><td>{totalDebitWei?`${weiToEthDisplay(totalDebitWei)} ETH`:'0.000000 ETH'}</td></tr>
            </tbody>
          </table>
        </div>
        {/* Prototype mint.html:85 -- while /api/mints/preview is in flight the column shows
            skeletons, not a half-filled ledger. Three row bars and a 60% line, exactly. */}
        {simulating&&<div>
          <div className="sk row"/><div className="sk row"/><div className="sk row"/><div className="sk l w60"/>
        </div>}
        {/* Ceiling only -- no meter and no "used" figure, because nothing exposes rolling spend
            (data contract §5.1). */}
        {ceilingWei!==undefined&&<div className="card tight">
          <div style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'11.5px',color:'var(--muted)'}}>
            <span>Your daily ceiling</span><span className="sp"/>
            <b className="tab" style={{color:'var(--text)'}}>{weiToEthDisplay(ceilingWei)} ETH</b></div>
        </div>}
        {pageError&&<Notice error={pageError}/>}
        {/* One CTA per state, all .big.bl, copy verbatim from the prototype. */}
        {noWallets
          ?<button type="button" className="b big bl" disabled>Create a wallet to mint</button>
          :simulating
            ?<button type="button" className="b big bl" disabled>Simulating…</button>
            :pageError
              ?<button type="button" className="b big bl" disabled>Cannot mint · see above</button>
              :<button type="button" className="b p big bl" disabled={!item} onClick={confirmMint}>
                 {item?`Confirm and mint · ${weiToEthDisplay(totalDebitWei)} ETH`:'Confirm and mint'}</button>}
        <p style={{fontSize:'11px',color:'var(--faint)',textAlign:'center'}}>
          {noWallets
            ?'Preview stays visible at all times — a collapsed total is a hidden total.'
            :'Broadcast is irreversible. Intent persisted before send.'}</p>
      </div>
    </div>
  </>;
}

/* --- Schedule status vocabulary -------------------------------------------------------------
   Mirrors TASK_BUCKETS / bucketFor() in src/scheduler/schedulerRepository.js. Module scope on
   purpose: these are constants and pure functions, and holding them inside the component put them
   in the temporal dead zone of the filtering code that runs earlier in the same body -- which
   threw "Cannot access 'EXPIRABLE' before initialization" and blanked the page.

   'all' is a view, not a status: it sends no filter. 'expired' is derived from the clock rather
   than stored -- the schema allows seven statuses and this is not one of them -- and it takes
   precedence over paused/failed so every row lands in exactly one bucket. Ordered by lifecycle
   (waiting -> suspended -> broke -> missed -> abandoned -> finished), the order a queue is read in.
   Tone follows meaning: red is failure only, amber is a window that went past, and cancelled stays
   neutral because the user chose it. */
const BUCKETS=[['all','All'],['pending','Pending'],['paused','Paused'],['failed','Failed'],
  ['expired','Expired'],['cancelled','Cancelled'],['succeeded','Successful']];
const BUCKET_STATUSES={pending:['scheduled','claimed','retry'],paused:['paused'],
  failed:['failed'],cancelled:['cancelled'],succeeded:['succeeded']};
const BUCKET_KEYS=['pending','paused','failed','expired','cancelled','succeeded'];
// One colour per state, so no two chips read as the same thing. Owner's ruling 2026-08-19:
// grey was doing too much work -- All, Paused, Cancelled and Successful all shared it, which made
// Cancelled indistinguishable from the "no filter" view sitting right next to it.
//   all        neutral   -- it is the absence of a filter, so it should not compete
//   pending    green     -- live and coming
//   paused     blue      -- deliberately held, not broken
//   failed     red       -- the only one that went wrong on its own
//   expired    amber     -- a window that went past
//   cancelled  violet    -- ended by choice, distinct from both grey and red
//   succeeded  accent    -- the theme's signature, the liveliest colour it has
const BUCKET_TONE={all:'nu',pending:'ok',paused:'info',failed:'bad',expired:'wn',
  cancelled:'idle',succeeded:'ac'};
const EXPIRABLE=['paused','failed'];
// Must match EXPIRY_GRACE_MS in src/scheduler/schedulerRepository.js. Expiry is not "the time has
// passed" -- a mint fails BECAUSE its time arrived, so that test would empty the failed bucket
// entirely and pile every failure into expired. It is "passed long enough ago that retrying or
// resuming is pointless": inside the hour a failure is worth another go, past it the drop is over.
const EXPIRY_GRACE_MS=60*60*1000;
function isExpired(task){
  const value=String(task?.status||'').toLowerCase();
  if(!EXPIRABLE.includes(value))return false;
  const at=task?.mintTime?new Date(task.mintTime).getTime():NaN;
  return Number.isFinite(at)&&at<Date.now()-EXPIRY_GRACE_MS;
}
function bucketOf(task){
  if(isExpired(task))return 'expired';
  const value=String(task?.status||'').toLowerCase();
  return Object.keys(BUCKET_STATUSES).find(key=>BUCKET_STATUSES[key].includes(value))||null;
}
function Tasks({profile}){const [page,setPage]=useState(1);const [search,setSearch]=useState('');const [bucket,setBucket]=useState('pending');const [filtersOpen,setFiltersOpen]=useState(false);const [serverFilters,setServerFilters]=useState(null);const PAGE_SIZE=10;const COMPAT_LIMIT=50;const listing=useLoad(serverFilters===false?`/api/tasks?page=1&pageSize=${COMPAT_LIMIT}&search=${encodeURIComponent(search)}`:`/api/tasks?page=${page}&pageSize=${PAGE_SIZE}&status=${bucket}&search=${encodeURIComponent(search)}`,[page,bucket,search,serverFilters],'tasks.changed');const wallets=useLoad('/api/wallets',[],'wallets.changed');const [chain,setChain]=useState(profile.defaultChain||profile.supportedChains[0]);const [contractAddress,setContractAddress]=useState('');const [quantity,setQuantity]=useState('1');const [priceETH,setPriceETH]=useState('');const [mintTime,setMintTime]=useState('');const [detecting,setDetecting]=useState(false);const lastDetected=useRef('');
  // The prototype's Schedule form has no price field, because it assumes the contract can be
  // priced automatically. Some cannot -- the server then rejects with a priceETH issue and there
  // is nowhere to type one, which left the form unsubmittable for those contracts. So the field
  // appears ONLY once that has happened, carrying the server's own message in the prototype's
  // .fielderr. A gap in the design rather than a departure from it; see backlog §14.
  const [priceIssue,setPriceIssue]=useState(null);
  const [selectedIds,setSelectedIds]=useState([]);
  function toggleSelected(id){setSelectedIds(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);}
  // Mirrors Minting's auto-detect: a scheduled mint needs the same price/opening-time knowledge an
  // immediate mint does, so this reuses the identical /api/mints/detect endpoint rather than making
  // the user look those up by hand. Price and time stay editable afterward -- detection pre-fills,
  // it never locks the field.
  async function detect(addressOverride){
    const trimmed=(addressOverride??contractAddress).trim();
    if(!trimmed){notify('Enter a contract address first.',{type:'error'});return;}
    setDetecting(true);
    try{
      const result=await api(`/api/mints/detect?contractAddress=${encodeURIComponent(trimmed)}&quantity=${encodeURIComponent(quantity)}`);
      lastDetected.current=trimmed;
      setChain(result.chain);
      if(result.priceKnown)setPriceETH(weiToEthDisplay(result.valueWei));
      if(result.startTime&&result.startTime*1000>Date.now()){
        const local=new Date(result.startTime*1000);
        local.setMinutes(local.getMinutes()-local.getTimezoneOffset());
        setMintTime(local.toISOString().slice(0,16));
      }
      const label=result.isSeaDrop?'SeaDrop drop':'contract';
      if(result.priceKnown)notify(`Detected ${label} on ${result.chain} — price read from the contract.`,{type:'success'});
      else notify(`Detected ${label} on ${result.chain}, but the price couldn't be read — enter it yourself.`,{type:'info'});
    }catch(value){notify(value.message,{type:'error'});}
    finally{setDetecting(false);}
  }
  // No manual "Detect" button -- mirrors Minting's autoDetectIfReady exactly: fires the moment a
  // full, valid-shaped address is present (on paste/every keystroke, not just on blur), taking the
  // just-changed value directly since setState hasn't applied yet inside the same onChange handler.
  function autoDetectIfReady(value=contractAddress){const trimmed=value.trim();if(ADDRESS_SHAPE.test(trimmed)&&trimmed!==lastDetected.current)detect(trimmed);}
  function handleContractBlur(){autoDetectIfReady();}
  async function create(event){event.preventDefault();const form=event.currentTarget;try{const input=Object.fromEntries(new FormData(form));if(!input.priceETH)delete input.priceETH;if(input.mintTime)input.mintTime=new Date(input.mintTime).toISOString();else delete input.mintTime;await api('/api/tasks',{method:'POST',body:JSON.stringify(input)});setPriceIssue(null);form.reset();setContractAddress('');setQuantity('1');setPriceETH('');setMintTime('');lastDetected.current='';notify('Task scheduled.',{type:'success'});listing.load();}catch(value){const issue=value.issues?.find(entry=>entry.field==='priceETH');if(issue)setPriceIssue(issue.message);notify(value.message,{type:'error'});}}async function control(id,action){try{await api(`/api/tasks/${id}/control`,{method:'POST',body:JSON.stringify({action,confirmation:action==='cancel'?'CONFIRM':undefined})});}catch(value){notify(value.message,{type:'error'});}}
  // Prototype docs/prototype-pages/mint.html:111-158. The Schedule tab is a .split: the form on
  // the left, the "Scheduled" list on the right. The old page-lead, the search toolbar, the chain
  // select and the table UNDER the form are all gone -- none of them exist in the design, and the
  // table in particular was the thing the owner asked to have removed.
  const walletsArrived=wallets.data!==null&&wallets.data!==undefined;
  const noWallets=walletsArrived&&wallets.data.length===0;
  // ---- Filtering, and where it happens -------------------------------------------------------
  // The server does this: it filters by bucket and counts all of them in one round trip. But
  // dashboard/vite.config.js proxies /api to the DEPLOYED instance, which does not have that code
  // yet, so on localhost the filter was sent and ignored -- the list never narrowed.
  //
  // So: detect it. A response carrying `counts` is a server that filters; one without is not.
  // When it is not, fetch up to COMPAT_LIMIT rows unfiltered and do the filtering and the paging
  // here instead. This is a SHIM with a real limit -- past 50 rows it can only see the first 50 --
  // and it disables itself the moment the server starts answering with counts. It is not a second
  // implementation to maintain: it reuses bucketOf, the same function the rows are labelled with.
  const compat=serverFilters===false;
  useEffect(()=>{
    if(listing.data&&serverFilters===null)setServerFilters(Boolean(listing.data.counts));
  },[listing.data,serverFilters]);
  const served=listing.data?.items;
  const matching=compat&&served
    ?served.filter(task=>bucket==='all'||bucketOf(task)===bucket)
    :null;
  const items=compat
    ?(matching?matching.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE):undefined)
    :served;
  const compatTotal=matching?matching.length:0;
  const pagerValue=compat
    ?{page,pageSize:PAGE_SIZE,total:compatTotal,totalPages:Math.max(1,Math.ceil(compatTotal/PAGE_SIZE))}
    :listing.data;
  // Truthful about its own blind spot rather than quietly showing a subset.
  const compatTruncated=compat&&listing.data?.total>COMPAT_LIMIT;
  // The prototype's chip reads "2 pending" above THREE rows -- Scheduled, Paused, Failed. So
  // "pending" means not-yet-fired: a paused mint still counts, a failed one does not. Counting
  // only status==="scheduled" would have printed 1 against the same three rows.
  // The five buckets partition every status the schema allows, so a row is always reachable under
  // exactly one filter. 'done' is not in the owner's original four -- without it a mint that
  // actually fired would be invisible under all of them. Mirrors TASK_BUCKETS in
  // src/scheduler/schedulerRepository.js; the server does the filtering and the counting.
  // 'all' is a view, not a status -- it sends no filter at all. Ordered by lifecycle (waiting ->
  // suspended -> broke -> abandoned -> finished) rather than by the order they were dictated,
  // because that is the order someone reads a queue in.
  // Counts come from the server because they describe the whole collection, not this page. The
  // fallback is load-bearing rather than defensive: dashboard/vite.config.js proxies /api to the
  // deployed instance, so until this ships the response carries no counts at all. Counting the
  // page keeps a wrong-but-plausible number instead of rendering "undefined", and it corrects
  // itself the moment the server catches up.
  const rawCounts=listing.data?.counts||(served?Object.fromEntries(BUCKET_KEYS.map(key=>
    [key,served.filter(task=>bucketOf(task)===key).length]))
    :Object.fromEntries(BUCKET_KEYS.map(key=>[key,0])));
  const counts={...rawCounts,all:Object.values(rawCounts).reduce((sum,value)=>sum+value,0)};
  // Tone follows meaning, not novelty. Failed is the only one that went wrong on its own, so it is
  // the only red: cancelled is something the user chose, and colouring a deliberate act like an
  // error teaches people to ignore red. Owner's ruling 2026-08-19.
  function rowIcon(status){
    const value=String(status||'').toLowerCase();
    if(value==='paused')return <div className="ri">{PAUSE_ICON}</div>;
    if(value==='failed'||value==='error')return <div className="ri" style={{color:'var(--loss-text)'}}>{CROSS_ICON}</div>;
    return <div className="ri">{CLOCK_ICON_LG}</div>;
  }
  function selectBucket(next){setBucket(next);setPage(1);setSelectedIds([]);setFiltersOpen(false);}
  // Collapsed, the control is ONE chip: the filter currently applied. Pressing it opens the rest,
  // pressing one of those applies it and closes again. The owner asked for the states not to sit
  // on screen all at once -- six permanent chips is a legend nobody reads, and it pushed the list
  // down a line. Escape and any outside click close it, so it never traps focus in the header.
  useEffect(()=>{
    if(!filtersOpen)return;
    const close=event=>{if(!event.target.closest?.('.fils'))setFiltersOpen(false);};
    const onKey=event=>{if(event.key==='Escape')setFiltersOpen(false);};
    document.addEventListener('click',close);
    document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('click',close);document.removeEventListener('keydown',onKey);};
  },[filtersOpen]);
  // The server is the authority on which control a status accepts, so this mirrors the WHERE
  // clauses in src/scheduler/schedulerRepository.js (pause/resume/retry/cancel, lines 137-155)
  // rather than reasoning about it independently. Cancel used to be treated as always available;
  // it is not -- the server takes it only for a mint that is still going to fire, and offering it
  // on an already-cancelled row just produced a rejection the user could do nothing about.
  const ACTIONS_BY_STATUS={
    scheduled:['pause','cancel'],
    retry:['pause','cancel'],
    paused:['resume','cancel'],
    failed:['retry'],
  };
  // Takes the whole task, not just its status, because expiry decides this as much as status
  // does. Resume and Retry are withheld once the mint time has gone: resuming or retrying then
  // only re-runs something whose drop is already over, which is the owner's point -- expired is a
  // state, not an action. An expired PAUSED mint can still be cancelled (the server's cancel
  // accepts 'paused'); an expired FAILED one accepts nothing, since retry is its only route.
  function actionsFor(task){
    const status=String(task?.status||'').toLowerCase();
    if(isExpired(task))return status==='paused'?['cancel']:[];
    return ACTIONS_BY_STATUS[status]||[];
  }
  // Selection is scoped to the page in view -- it clears on paging and on changing filter -- and
  // intersecting here as well is what stops a control being enabled with nothing behind it.
  const selected=(items||[]).filter(task=>selectedIds.includes(task.id));
  // The FIRST row selected fixes what the selection IS: only rows offering exactly the same set
  // of actions can join it. Mixing was previously allowed, with an action quietly applying to the
  // subset that could take it -- press Cancel on a scheduled row and a cancelled one together and
  // one changes while the other silently does not, with nothing on screen saying so. The owner
  // ruled that out: "I cannot select a scheduled item, then also select another one, and it now
  // be cancelled." Rows that cannot join are left inert rather than hidden, so the list does not
  // reshuffle under the cursor as a selection is built.
  const selectionKey=selected.length?actionsFor(selected[0]).join('+'):null;
  const canSelect=task=>selectionKey===null||actionsFor(task).join('+')===selectionKey;
  function chooseRow(task){if(canSelect(task))toggleSelected(task.id);}
  // Because the selection is homogeneous, "this action is offered" and "this action will run
  // against every selected row" are now the same statement -- which is what makes the button
  // labels honest.
  function selectionSupports(action){
    return selected.length>0&&actionsFor(selected[0]).includes(action);
  }
  async function controlSelected(action){
    if(!selectionSupports(action))return;
    const targets=selected;
    if(!targets.length)return;
    if(action==='cancel'&&!await confirmDialog(targets.length===1
      ?'Cancel this scheduled mint? It will not fire, and this cannot be undone.'
      :`Cancel ${targets.length} scheduled mints? They will not fire, and this cannot be undone.`))return;
    for(const task of targets)await control(task.id,action);
    setSelectedIds([]);
    listing.load();
  }
  // The prototype writes a DIFFERENT meta line per state, and the failed one is the reason:
  //   scheduled  "Primary · fires in 42m · 2026-08-20T18:00:00Z"
  //   paused     "Trading · paused"
  //   failed     "attempt 3 of 3 · sale not active"
  // The build printed wallet + timestamp on every row regardless, so a failure said only that it
  // failed. lastError has carried the reason all along -- "Simulating this call failed:
  // insufficient funds" -- it was simply never shown. A state the user cannot act on because it
  // will not say what went wrong is the thing the owner asked to end.
  function rowMeta(task){
    const key=bucketOf(task);
    if((key==='failed'||key==='expired')&&task.lastError){
      const attempt=task.attemptCount||0,cap=task.maxAttempts||3;
      return `attempt ${attempt} of ${cap} · ${task.lastError}`;
    }
    if(key==='paused')return `${task.walletLabel} · paused`;
    const at=task.mintTime?new Date(task.mintTime):null;
    if(!at||Number.isNaN(at.getTime()))return String(task.walletLabel||'');
    const ms=at.getTime()-Date.now();
    if(ms>0){
      const mins=Math.round(ms/60000);
      const when=mins<60?`fires in ${mins}m`:mins<1440?`fires in ${Math.round(mins/60)}h`:`fires in ${Math.round(mins/1440)}d`;
      return `${task.walletLabel} · ${when} · ${at.toISOString()}`;
    }
    return `${task.walletLabel} · ${at.toISOString()}`;
  }
  function rowPill(task){
    const key=bucketOf(task);
    // An expired row says "expired" rather than "paused"/"failed", because that is the fact that
    // decides what you can do with it.
    return <span className={`p ${key?BUCKET_TONE[key]:'nu'}`}>{key==='expired'?'expired':task.status}</span>;
  }
  return <div className="split">
    <div className="card">
      <div className="ch"><div className="chip-ico">{CLOCK_ICON_LG}</div><h2>Schedule a mint</h2></div>
      <form className="g" style={{gap:'11px'}} onSubmit={create}>
        <label className="fl"><span>Name</span>
          <input className="in" name="name" required disabled={noWallets} placeholder="e.g. Pudgy Rods public"/></label>
        <label className="fl"><span>Contract address</span>
          <input className="in mono" name="contractAddress" required disabled={noWallets} placeholder="0x…"
            value={contractAddress}
            onChange={e=>{setContractAddress(e.target.value);autoDetectIfReady(e.target.value);}}
            onBlur={handleContractBlur}/></label>
        <div className="nt i">{INFO_ICON}
          <div>SeaDrop drops expose their own opening time on-chain — it is filled in automatically. A plain <code>mint(uint256)</code> contract has no equivalent, so you set the time yourself.</div></div>
        <div className="g gm2 g2">
          <label className="fl"><span>Wallet</span>
            {noWallets
              ?<select className="in" disabled><option>No wallets yet</option></select>
              :<select className="in" name="walletLabel" disabled={!walletsArrived}>
                <optgroup label="EVM">{(wallets.data||[]).map(entry=><option key={entry.label} value={entry.label}>{entry.label}</option>)}</optgroup>
              </select>}
          </label>
          <label className="fl"><span>Quantity</span>
            <div className="qty">
              <input className="in tab" name="quantity" type="number" min={1} max={100} disabled={noWallets}
                placeholder="Enter quantity (1–100)" value={quantity} onChange={e=>setQuantity(e.target.value)}/>
              {/* Shared rule against this form's cap of 100 -> 1, 2, 50, Max. Backlog §13. */}
              <div className="qb">{quantityPicks(100).map(pick=><button type="button" key={pick} disabled={noWallets}
                className={String(pick)===String(quantity)?'on':undefined}
                onClick={()=>setQuantity(String(pick))}>{pick}</button>)}
                <button type="button" disabled={noWallets}
                  className={String(quantity)==='100'?'on':undefined}
                  onClick={()=>setQuantity('100')}>Max</button></div>
            </div></label>
        </div>
        <label className="fl"><span>Mint time <span style={{color:'var(--faint)',fontWeight:500}}>· UTC, explicit offset or Z</span></span>
          <input className="in tab mono" name="mintTime" type="datetime-local" disabled={noWallets}
            value={mintTime} onChange={e=>setMintTime(e.target.value)}/></label>
        {priceIssue
          ?<label className="fl"><span>Price per mint <span style={{color:'var(--faint)',fontWeight:500}}>· ETH</span></span>
             <input className="in tab bad" name="priceETH" type="number" step="any" min="0" required
               placeholder="e.g. 0.08" value={priceETH} onChange={e=>setPriceETH(e.target.value)}/>
             <div className="fielderr">{ALERT_ICON}{priceIssue}</div></label>
          :priceETH?<input type="hidden" name="priceETH" value={priceETH}/>:null}
        <input type="hidden" name="chain" value={chain}/>
        <button className="b p" disabled={noWallets}>Schedule mint</button>
      </form>
    </div>

    <div className="g">
      <div className="card">
        {/* The prototype's static "2 pending" chip, now the filter. It stays ON THE TITLE LINE
            where that chip was, and stays a SINGLE chip until pressed -- see selectBucket's note.
            Each chip carries its own count, which is why the server scopes counts to the search
            but NOT to the active filter: a chip reading 0 only because it is not the current view
            would be worse than no chip at all. */}
        <div className="ch"><h2>Scheduled</h2><div className="sp"/>
          <div className={`fils${filtersOpen?' open':''}`}>
            {/* The trigger never leaves the title line -- it IS the chip that used to live here,
                now reading whichever filter is applied. The alternatives open beneath it rather
                than expanding inline, because .ch does not wrap (prototype.css:281) and six chips
                would either overflow the header or force the list down a row. */}
            <button type="button" className={`p ${BUCKET_TONE[bucket]} fil on`}
              aria-haspopup="listbox" aria-expanded={filtersOpen}
              onClick={()=>setFiltersOpen(open=>!open)}>
              {counts[bucket]??0} {(BUCKETS.find(([key])=>key===bucket)?.[1]||'').toLowerCase()}
              <span className="fil-caret" aria-hidden="true">▾</span>
            </button>
            {filtersOpen&&<div className="fil-pop" role="listbox" aria-label="Filter by state">
              {BUCKETS.map(([key,label])=><button type="button" key={key} role="option"
                aria-selected={bucket===key}
                className={`p ${BUCKET_TONE[key]} fil${bucket===key?' on':''}`}
                onClick={()=>selectBucket(key)}>
                {counts[key]??0} {label.toLowerCase()}</button>)}
            </div>}
          </div>
        </div>
        {listing.error
          ?<Notice error={loadError(listing,'Could not load scheduled mints.')}/>
          :items===undefined||items===null
            ?<div><div className="sk row"/><div className="sk row"/><div className="sk row"/></div>
            :items.length===0
              ?<div className="emp">
                 <div className="ei">{CLOCK_ICON_LG}</div>
                 {/* The prototype's empty state assumed an unfiltered list. With a filter applied,
                     "Nothing scheduled" would be a lie about the collection rather than a fact
                     about the view, so the filtered case says which view is empty. */}
                 {bucket==='pending'||bucket==='all'
                   ?<><h3>Nothing scheduled</h3>
                     <p>A scheduled mint is a database row, not a browser timer — it fires whether or not this tab is open.</p></>
                   :<><h3>No {BUCKETS.find(([key])=>key===bucket)?.[1].toLowerCase()} mints</h3>
                     <p>Nothing here right now. Other states may still have mints — the counts above show which.</p></>}
               </div>
              :<div>
                 {/* Says so out loud rather than quietly showing a subset. Only reachable before
                     the server-side filter deploys, and only past the 50-row window. */}
                 {compatTruncated&&<div className="nt i" style={{marginBottom:'9px'}}>{INFO_ICON}
                   <div>Filtering the newest {COMPAT_LIMIT} of {listing.data.total} scheduled mints.
                   The full-collection filter arrives with the next deploy.</div></div>}
                 {/* The whole row is the control: click to select, click again to drop it. The
                     checkboxes that were here are gone at the owner's instruction -- selection now
                     reads as a highlight on the row itself (.r.on), which is why the row carries
                     role="button" and aria-pressed rather than hiding an input inside it.
                     A row that cannot join the current selection gets .r.off and is not focusable,
                     so the rule is visible before it is discovered by clicking. */}
                 {items.map(task=>{
                   const chosen=selectedIds.includes(task.id);
                   const selectable=canSelect(task);
                   return <div key={task.id}
                     className={`r${chosen?' on':''}${selectable?'':' off'}`}
                     role="button" tabIndex={selectable?0:-1}
                     aria-pressed={chosen} aria-disabled={selectable?undefined:true}
                     onClick={()=>chooseRow(task)}
                     onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){
                       event.preventDefault();chooseRow(task);}}}>
                     {rowIcon(task.status)}
                     <div className="rm">
                       <div className="rt">{task.name}</div>
                       <div className="rs fold">{rowMeta(task)}</div>
                     </div>
                     <div className="rv">{rowPill(task)}</div>
                   </div>;
                 })}
                 {/* All four always present, as the prototype draws them; the ones that cannot
                     apply to the current selection are disabled rather than hidden, so the row
                     does not reflow as the selection changes. .b[disabled] is the prototype's
                     own treatment for exactly this. */}
                 <div className="br" style={{marginTop:'11px'}}>
                   {['pause','resume','retry'].map(action=><button type="button" key={action} className="b sm"
                     disabled={!selectionSupports(action)} onClick={()=>controlSelected(action)}>
                     {action[0].toUpperCase()+action.slice(1)}</button>)}
                   <button type="button" className="b d sm" disabled={!selectionSupports('cancel')}
                     onClick={()=>controlSelected('cancel')}>Cancel…</button>
                 </div>
                 {/* A selection belongs to the page it was made on, so leaving the page drops it.
                     Guarded on an ACTUAL change: pressing the number you are already on is a no-op,
                     and a no-op that silently throws away a selection is just a trap. */}
                 <Pager value={pagerValue} page={page}
                   setPage={value=>{if(value!==page)setSelectedIds([]);setPage(value);}}/>
               </div>}
      </div>
    </div>
  </div>;
}
// One tone per outcome, so a list reads the same way everywhere. Extends the Schedule card's
// vocabulary to the other lists at the owner's request: green for something that worked, red for
// something that failed, and AMBER for a refusal -- which was previously indistinguishable from a
// failure even though it means something quite different (the system said no, rather than broke).
const OUTCOME_TONE={
  success:'ok', confirmed:'ok', succeeded:'ok', allowed:'ok', ok:'ok',
  fail:'bad', failed:'bad', failure:'bad', error:'bad', reverted:'bad',
  unauthorized:'wn', denied:'wn', rejected:'wn', blocked:'wn', 'rate-limited':'wn',
};
function outcomeTone(value){return OUTCOME_TONE[String(value||'').toLowerCase()]||'nu';}
// Platform is a source, not an outcome, so it gets its own neutral chip rather than competing
// with the colour that carries meaning.
function PlatformChip({platform}){
  if(!platform)return null;
  return <span className="p nu" style={{textTransform:'capitalize'}}>{platform}</span>;
}
function Activity(){const [page,setPage]=useState(1);const [search,setSearch]=useState('');const listing=useLoad(`/api/activity?page=${page}&pageSize=10&search=${encodeURIComponent(search)}`,[page,search],ACTIVITY_EVENTS);return <><p className="page-lead">Paginated execution history with trigger and verification context where recorded.</p><Notice error={loadError(listing,'Could not load activity.')}/><div className="page-toolbar"><label className="page-search">Find activity<input type="search" value={search} placeholder="Title or wallet…" onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label></div>{listing.data===null?<Skeleton variant="lines" rows={4}/>:<><div className="feed activity-feed">{listing.data.items.map(item=><article className="feed-item" key={item.id}><div><span className={`p ${outcomeTone(item.status)}`}>{item.status}</span><h2>{item.title}</h2><p>{item.walletLabel||'No wallet'} · {new Date(item.time).toLocaleString()}</p></div><div className="activity-context"><p>Trigger: {item.triggerSource||'legacy/unrecorded'}</p><p>Verification: {item.verificationState||'not applicable'}</p></div></article>)}</div>{listing.data.items.length===0&&<Empty text={search?'No activity matches this search.':'No activity recorded yet.'}/>}<Pager value={listing.data} page={page} setPage={setPage}/></>}</>}
// Every confirmed mint auto-creates its own record now (see recordMintActivity/autoRecordPnl in
// src/server.js) with real cost+gas and sale left at 0 until something actually sells -- these
// rollups are computed straight from that same already-loaded list, not a separate fetch, since
// summing what's already on screen is simpler than a new endpoint for the same numbers.
const PNL_PERIODS=[['day','Today',86400000],['week','7 days',7*86400000],['month','30 days',30*86400000],['year','365 days',365*86400000]];
function summarizePnlPeriod(records,windowMs){const cutoff=Date.now()-windowMs;const inWindow=records.filter(item=>item.t>=cutoff);
  return {count:inWindow.length,cost:inWindow.reduce((sum,item)=>sum+Number(item.cost),0),sale:inWindow.reduce((sum,item)=>sum+Number(item.sale),0),
    gas:inWindow.reduce((sum,item)=>sum+Number(item.gas),0),net:inWindow.reduce((sum,item)=>sum+Number(item.net),0)};}
function Pnl(){const listing=useLoad('/api/pnl',[],'pnl.changed');const [editing,setEditing]=useState(null);const [query,setQuery]=useState('');async function save(event){event.preventDefault();const form=event.currentTarget;const wasEditing=editing;const body=JSON.stringify(Object.fromEntries(new FormData(form)));try{await api(wasEditing?`/api/pnl/${wasEditing}`:'/api/pnl',{method:wasEditing?'PUT':'POST',body});setEditing(null);form.reset();notify(wasEditing?'Record updated.':'Record added.',{type:'success'});listing.load();}catch(value){notify(value.message,{type:'error'});}}async function remove(id){if(!await confirmDialog('Delete this P&L record?'))return;try{await api(`/api/pnl/${id}`,{method:'DELETE',body:JSON.stringify({confirmation:'CONFIRM'})});listing.load();}catch(value){notify(value.message,{type:'error'});}}const current=listing.data?.find(x=>x.id===editing);const normalized=query.trim().toLowerCase();const filtered=listing.data?(normalized?listing.data.filter(item=>String(item.nm||'').toLowerCase().includes(normalized)):listing.data):null;return <><p className="page-lead">Cost and gas are recorded automatically on every confirmed mint; sale stays editable below once something actually sells.</p><Notice error={loadError(listing,'Could not load your P&L records.')}/>{listing.data&&<div className="card-grid pnl-summary-grid">{PNL_PERIODS.map(([key,label,windowMs])=>{const summary=summarizePnlPeriod(listing.data,windowMs);return <article className="card pnl-summary-card" key={key}><span className="eyebrow">{label}</span><strong className={summary.net<0?'net-loss':'net-gain'}>Net {summary.net>0?'+':''}{summary.net.toFixed(4)}</strong><p>{summary.count} record{summary.count===1?'':'s'} · Cost {summary.cost.toFixed(4)} · Sale {summary.sale.toFixed(4)} · Gas {summary.gas.toFixed(4)}</p></article>;})}</div>}<div className="page-toolbar"><label className="page-search">Find a record<input type="search" value={query} placeholder="Name…" onChange={e=>setQuery(e.target.value)}/></label></div><Form className="form-pnl" key={editing||'new'} title={editing?'Edit record':'Add record'} note="Auto-created records can be edited here too -- fill in Sale once an NFT actually resells." onSubmit={save}><Field name="name" label="Name" defaultValue={current?.nm}/><Field name="cost" label="Cost" type="number" step="any" defaultValue={current?.cost??0}/><Field name="sale" label="Sale" type="number" step="any" defaultValue={current?.sale??0}/><Field name="gas" label="Gas" type="number" step="any" defaultValue={current?.gas??0}/><button className="b p">{editing?'Save changes':'Add record'}</button>{editing&&<button type="button" className="b g" onClick={()=>setEditing(null)}>Cancel edit</button>}</Form>{listing.data===null?<Skeleton/>:<div className="card-grid pnl-grid">{filtered.map(item=><article className="card" key={item.id}><h2>{item.nm}</h2><p>Cost {item.cost} · Sale {item.sale} · Gas {item.gas}</p><strong className={Number(item.net)<0?'net-loss':'net-gain'}>Net {Number(item.net)>0?'+':''}{item.net}</strong><div className="br"><button className="b g sm" onClick={()=>setEditing(item.id)}>Edit</button><button className="b d sm" onClick={()=>remove(item.id)}>Delete</button></div></article>)}{filtered.length===0&&<Empty text={normalized?'No P&L records match this search.':'No P&L records yet.'}/>}</div>}</>}
function jsonForm(event){event.preventDefault();const form=event.currentTarget;return {form,value:JSON.parse(new FormData(form).get('json'))};}
// policyFor: which card has its policy expanded. A policy configures an existing target, so it
// now lives ON that target's card rather than on a page of its own (brief §2). Same PolicyEditor,
// same routes, new place -- including the bypass challenge, which keeps its explicit CONFIRM step.
function Snipers(){const listing=useLoad('/api/snipers',[],'snipers.changed');const [editing,setEditing]=useState(null);const [query,setQuery]=useState('');const [policyFor,setPolicyFor]=useState(null);async function save(event){try{const {form,value}=jsonForm(event);const wasEditing=editing;await api(editing?`/api/snipers/${editing}`:'/api/snipers',{method:editing?'PUT':'POST',body:JSON.stringify(value)});form.reset();setEditing(null);notify(wasEditing?'Sniper updated.':'Sniper created.',{type:'success'});listing.load();}catch(value){notify(value.message,{type:'error'});}}async function remove(id){if(!await confirmDialog('Remove this post-confirmation copy sniper?'))return;try{await api(`/api/snipers/${id}`,{method:'DELETE',body:JSON.stringify({confirmation:'CONFIRM'})});listing.load();}catch(value){notify(value.message,{type:'error'});}}const normalized=query.trim().toLowerCase();const filtered=listing.data?{...listing.data,items:normalized?listing.data.items.filter(item=>[item.label,item.chain,item.walletLabel].filter(Boolean).some(value=>String(value).toLowerCase().includes(normalized))):listing.data.items}:null;return <><p className="page-lead">Copies confirmed wallet transactions after their confirmation threshold. This is not mempool front-running.</p><Notice error={loadError(listing,'Could not load your triggers.')}/><div className="page-toolbar"><label className="page-search">Find a sniper<input type="search" value={query} placeholder="Label, chain, wallet…" onChange={e=>setQuery(e.target.value)}/></label></div><Form className="form-json" title={editing?'Edit sniper patch':'Create sniper'} note="The same M10 validation and M7a ceilings used by Telegram and Discord apply here." onSubmit={save}><label>Configuration JSON<textarea name="json" required defaultValue={editing?'{}':'{"label":"copy","targetAddress":"0x0000000000000000000000000000000000000001","chain":"ethereum","walletLabel":"wallet","maxValueETH":0.01,"maxGasGwei":50,"dailySpendingCapETH":0.05,"cooldownMs":60000,"maxAttempts":3}'}/></label><button className="b p">{editing?'Apply validated patch':'Create sniper'}</button></Form>{listing.data===null?<Skeleton/>:<div className="card-grid sniper-grid">{filtered.items.map(item=>{const recent=listing.data.events.filter(event=>event.sniperId===item.id)[0];return <article className="card" key={item.id}><StatusPill status={recent?.state||'no events'}/><h2>{item.label}</h2><p className="warning">Post-confirmation copy; not front-running.</p><p>{item.chain} · wallet {item.walletLabel}</p><p>Max {item.maxValueETH} ETH · Gas {item.maxGasGwei} gwei · Daily {item.dailySpendingCapETH} ETH</p><p>Cooldown {item.cooldownMs} ms · Attempts {item.maxAttempts}</p><p>Allow: {item.contractAllowlist.join(', ')||'any'}<br/>Deny: {item.contractDenylist.join(', ')||'none'}</p><div className="br"><button className="b g sm" onClick={()=>setEditing(item.id)}>Edit</button><button className="b g sm" aria-expanded={policyFor===item.id} onClick={()=>setPolicyFor(policyFor===item.id?null:item.id)}>{policyFor===item.id?'Hide policy':'Policy'}</button><button className="b d sm" onClick={()=>remove(item.id)}>Remove</button></div>{policyFor===item.id&&<PolicyEditor target={{id:item.id,label:item.label,type:'sniper'}}/>}</article>})}{filtered.items.length===0&&<Empty text={normalized?'No snipers match this search.':'No snipers yet. Create one above to start post-confirmation copying.'}/>}</div>}</>}
function WatchRules(){const listing=useLoad('/api/watch-rules',[],'watchrules.changed');const [editing,setEditing]=useState(null);const [query,setQuery]=useState('');const [policyFor,setPolicyFor]=useState(null);async function save(event){try{const {form,value}=jsonForm(event);const wasEditing=editing;await api(editing?`/api/watch-rules/${editing}`:'/api/watch-rules',{method:editing?'PUT':'POST',body:JSON.stringify(value)});form.reset();setEditing(null);notify(wasEditing?'Watch rule updated.':'Watch rule created.',{type:'success'});listing.load();}catch(value){notify(value.message,{type:'error'});}}async function action(id,name){try{await api(`/api/watch-rules/${id}${name==='disable'?'/disable':''}`,{method:name==='remove'?'DELETE':'POST',body:JSON.stringify(name==='remove'?{confirmation:'CONFIRM'}:{})});listing.load();}catch(value){notify(value.message,{type:'error'});}}const normalized=query.trim().toLowerCase();const filtered=listing.data?{...listing.data,items:normalized?listing.data.items.filter(item=>[item.name,item.type,item.method].filter(Boolean).some(value=>String(value).toLowerCase().includes(normalized))):listing.data.items}:null;return <><p className="page-lead">Manage adapter-backed Twitter/X and Discord source monitoring.</p><Notice error={loadError(listing,'Could not load your triggers.')}/><div className="page-toolbar"><label className="page-search">Find a watch rule<input type="search" value={query} placeholder="Name, type, method…" onChange={e=>setQuery(e.target.value)}/></label></div><Form className="form-json" title={editing?'Edit watch rule patch':'Create watch rule'} onSubmit={save}><label>Configuration JSON<textarea name="json" required defaultValue={editing?'{}':'{"name":"announcements","type":"discord_channel","method":"scraper","config":{"channelId":"123","keywords":["mint"],"sourceUrl":"https://example.com/feed"}}'}/></label><button className="b p">{editing?'Apply validated patch':'Create rule'}</button></Form>{listing.data===null?<Skeleton/>:<div className="card-grid watch-grid">{filtered.items.map(item=>{const events=listing.data.events.filter(event=>event.matchedRuleIds.includes(item.id)).slice(0,3);return <article className="card" key={item.id}><StatusPill status={item.enabled?'enabled':'disabled'}/><h2>{item.name}</h2><p>{item.type} · {item.method}</p><p className={item.consecutiveFailures?'warning':''}>Adapter health: {item.consecutiveFailures?`failing (${item.consecutiveFailures} consecutive)`:'healthy'} </p>{events.map(event=><p key={event.id}><code>{event.address}</code><br/>{new Date(event.detectedAt).toLocaleString()}</p>)}<div className="br"><button className="b g sm" onClick={()=>setEditing(item.id)}>Edit</button><button className="b g sm" onClick={()=>action(item.id,'disable')}>Disable</button><button className="b g sm" aria-expanded={policyFor===item.id} onClick={()=>setPolicyFor(policyFor===item.id?null:item.id)}>{policyFor===item.id?'Hide policy':'Policy'}</button><button className="b d sm" onClick={async()=>{if(await confirmDialog('Remove this watch rule?'))action(item.id,'remove');}}>Remove</button></div>{policyFor===item.id&&<PolicyEditor target={{id:item.id,label:item.name,type:'social_rule'}}/>}</article>})}{filtered.items.length===0&&<Empty text={normalized?'No watch rules match this search.':'No watch rules yet. Create one above to start social-trigger detection.'}/>}</div>}</>}
function PolicyEditor({target,onChanged,highlighted}){const details=useLoad(`/api/targets/${target.id}?type=${target.type}`,[target.id,target.type]);const presets=useLoad('/api/mode-presets');const [challenge,setChallenge]=useState(null);async function update(event){event.preventDefault();const value=Object.fromEntries(new FormData(event.currentTarget));try{await api(`/api/targets/${target.id}`,{method:'PUT',body:JSON.stringify({...value,targetType:target.type})});notify('Policy saved.',{type:'success'});details.load();onChanged?.();}catch(x){notify(x.message,{type:'error'});}}async function bypass(event){event.preventDefault();try{setChallenge(await api(`/api/targets/${target.id}/bypass`,{method:'POST',body:JSON.stringify({targetType:target.type,dontAskAgain:new FormData(event.currentTarget).get('dontAskAgain')==='on'})}));}catch(x){notify(x.message,{type:'error'});}}async function confirmBypass(event){event.preventDefault();try{await api('/api/targets/bypass/confirm',{method:'POST',body:JSON.stringify({challengeId:challenge.challengeId,confirmation:new FormData(event.currentTarget).get('confirmation')})});setChallenge(null);notify('Bypass confirmed.',{type:'success'});details.load();}catch(x){notify(x.message,{type:'error'});}}async function preset(key){try{const result=await api(`/api/targets/${target.id}/preset`,{method:'POST',body:JSON.stringify({targetType:target.type,presetKey:key})});if(result.requiresConfirmation)setChallenge(result);else notify('Preset applied.',{type:'success'});details.load();}catch(x){notify(x.message,{type:'error'});}}const value=details.data;return <article className={`panel${highlighted?' policy-highlighted':''}`}><h2>{target.label}</h2><Notice error={loadError(details,'Could not load this target’s policy.')}/>{value&&<><p>Effective ceiling (read only): {value.governance.maxTransactionValueWei} wei/tx, {value.governance.dailySpendingBudgetWei} wei/day, {value.governance.gasCeilingGwei} gwei gas.</p><Form title="Trigger behavior" onSubmit={update}><input type="hidden" name="targetType" value={target.type}/><Select name="blockchainTrigger" label="Blockchain trigger" options={['auto','manual']} defaultValue={value.policy.blockchainTrigger}/><Select name="socialTrigger" label="Social trigger" options={['auto','manual']} defaultValue={value.policy.socialTrigger}/><Select name="humanVerification" label="Verification" options={['on']} defaultValue="on"/><button className="b p">Save policy</button></Form><div className="br">{presets.data?.map(p=><button className="b sm" key={p.key} onClick={()=>preset(p.key)}>{p.displayName}</button>)}</div><form className="bypass" onSubmit={bypass}><label><input type="checkbox" name="dontAskAgain"/> Don&apos;t ask again for this target only</label><button className="b d">Request bypass</button></form>{challenge?.requiresConfirmation&&<form className="warning-box" onSubmit={confirmBypass}><strong>{challenge.warning}</strong><p>Type CONFIRM exactly to enable the highest-risk configuration.</p><input name="confirmation" autoComplete="off"/><button className="b d">Confirm bypass</button></form>}</>}</article>}
// `target` arrives from a /dashboard/target-policies/:id deep link, rewritten to
// ?target=:id. A bookmark that pointed at one policy still lands on that policy: the matching
// card is rendered first and marked, rather than the user being dropped into an unordered grid
// and left to find it. An id that no longer exists degrades to the plain list.
function TargetPolicies({target}){
  const snipers=useLoad('/api/snipers',[],'snipers.changed');
  const rules=useLoad('/api/watch-rules',[],'watchrules.changed');
  const all=[...(snipers.data?.items||[]).map(x=>({id:x.id,label:x.label,type:'sniper'})),...(rules.data?.items||[]).map(x=>({id:x.id,label:x.name,type:'social_rule'}))];
  const targets=target?[...all.filter(item=>item.id===target),...all.filter(item=>item.id!==target)]:all;
  const missing=Boolean(target)&&!all.some(item=>item.id===target)&&snipers.data!==null&&rules.data!==null;
  return <>
    <p className="eyebrow">Per-target safety — trigger modes, verification, presets, and read-only effective governance ceilings.</p>
    {missing&&<Notice error={`No target matches ${target}. It may have been removed. Showing all targets instead.`}/>}
    {snipers.data!==null&&rules.data!==null&&all.length===0
      &&<Empty text="No triggers yet. Create a sniper or a social rule first — a policy configures an existing target, it does not create one."/>}
    <div className="policy-grid">{targets.map(item=><PolicyEditor key={`${item.type}:${item.id}`} target={item} highlighted={item.id===target}/>)}</div>
  </>;
}
const BELL_ICON=<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M18 8A6 6 0 1 0 6 8c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>;
// The bell surfaces two different things: pending confirmations (actionable, drive the badge
// count) and a short recent-notifications log (informational, sourced from the same notify() log
// the toast host reads -- so anything a toast reported is still checkable here after it auto-dismisses).
function NotificationBell(){const [items,setItems]=useState([]);const [open,setOpen]=useState(false);const [log,setLog]=useState(getNotificationLog());const [autoPreview,setAutoPreview]=useState(null);const seenIds=useRef(new Set(getNotificationLog().map(entry=>entry.id)));const autoPreviewTimer=useRef(null);const load=useCallback(()=>api('/api/confirmations').then(setItems).catch(x=>notify(x.message,{type:'error'})),[]);useEffect(()=>{load();const listener=event=>{const message=event.detail;if(message.type==='confirmation.pending')setItems(current=>[message.request,...current.filter(x=>x.id!==message.request.id)]);if(message.type==='confirmation.resolved')setItems(current=>current.filter(x=>x.id!==message.requestId));};window.addEventListener('ghostmint-ws',listener);return()=>window.removeEventListener('ghostmint-ws',listener);},[load]);
  // Server-side outcomes become actionable notifications here. The scheduler already knew a mint
  // had failed and why; until now that only reached Telegram, so on the dashboard a scheduled
  // mint just quietly changed colour in a list you had to already be looking at.
  //
  // Each one carries the control the owner asked for: a failure retries, a low balance opens the
  // wallet that is short. Retry goes through the same /control endpoint the Schedule tab uses, so
  // the server's own status guards still apply -- a mint that is no longer retryable is refused
  // here exactly as it would be there.
  useEffect(()=>{
    function onMessage(event){
      const message=event.detail;
      if(message?.type==='task.failed'){
        notify(`${message.name} failed — ${message.reason}`,{type:'error',category:'auto',timeoutMs:9000,
          action:{label:'Retry',run:async()=>{
            await api(`/api/tasks/${message.taskId}/control`,{method:'POST',body:JSON.stringify({action:'retry'})});
            notify(`${message.name} queued for another attempt.`,{type:'success',category:'auto'});
          }}});
      }
      if(message?.type==='task.lowBalance'){
        notify(`${message.name} mints in ${message.minutes}m and ${message.walletLabel} is short by ${message.shortByEth} ETH.`,
          {type:'error',category:'money',timeoutMs:12000,
           action:{label:'Top up wallet',run:async()=>{window.location.href='/dashboard/wallets';}}});
      }
      if(message?.type==='task.succeeded'){
        notify(`${message.name} minted.`,{type:'success',category:'money'});
      }
    }
    window.addEventListener('ghostmint-ws',onMessage);
    return()=>window.removeEventListener('ghostmint-ws',onMessage);
  },[]);
  // New notifications pop a compact preview off the bell itself (not the full dropdown) for a few
  // seconds, so you don't have to open the list to notice something just happened. Suppressed while
  // the full dropdown is already open, since the new entry is already visible there.
  useEffect(()=>subscribeNotificationLog(next=>{
    setLog(next);
    const newest=next[0];
    if(newest&&!seenIds.current.has(newest.id)){
      seenIds.current.add(newest.id);
      if(!open){
        setAutoPreview(newest);
        clearTimeout(autoPreviewTimer.current);
        autoPreviewTimer.current=setTimeout(()=>setAutoPreview(null),5000);
      }
    }
  }),[open]);
  useEffect(()=>()=>clearTimeout(autoPreviewTimer.current),[]);
  async function resolve(id,decision){try{await api(`/api/confirmations/${id}`,{method:'POST',body:JSON.stringify({decision})});setItems(current=>current.filter(x=>x.id!==id));}catch(x){notify(x.message,{type:'error'});load();}}
  function dismissAutoPreview(){setAutoPreview(null);clearTimeout(autoPreviewTimer.current);}
  function toggleBell(){if(autoPreview){dismissAutoPreview();return;}setOpen(value=>!value);}
  // Prototype .bell-pop (ghostmint-redesign-v3.html:2147), backlog §3. Two tabs, not two stacked
  // headings: "Needs you" is the actionable queue and is the ONLY thing the badge counts; "Recent"
  // is the capped session log the toasts also write to. The footer says exactly that, because the
  // distinction is the whole point of the design -- Recent is a scratchpad, never an inbox.
  const [tab,setTab]=useState('needs');
  const [runningAction,setRunningAction]=useState(null);
  async function runEntryAction(entry){
    if(!entry.action||runningAction)return;
    setRunningAction(entry.id);
    try{await entry.action.run();}catch(error){notify(error.message,{type:'error'});}
    finally{setRunningAction(null);}
  }
  const CATEGORY_LABELS={money:'Money',auto:'Auto',security:'Security'};
  const DOT_FOR_TYPE={success:'var(--gain)',error:'var(--loss)',info:'var(--accent)'};
  return <div className="notification-bell">
    <button type="button" className="ib" aria-label="Notifications" aria-expanded={open} onClick={toggleBell}>
      {BELL_ICON}{items.length>0&&<span className="badge">{items.length}</span>}</button>
    {open&&<div className="bell-backdrop" onClick={()=>setOpen(false)}/>}
    {open&&<div className="bell-pop on" role="dialog" aria-label="Notifications">
      <div className="bell-h"><h3>Notifications</h3></div>
      <div className="bell-tabs">
        <button type="button" className={tab==='needs'?'on':undefined} aria-pressed={tab==='needs'}
          onClick={()=>setTab('needs')}>Needs you{items.length>0&&
          <span className="cnt hot" style={{marginLeft:'3px'}}>{items.length}</span>}</button>
        <button type="button" className={tab==='recent'?'on':undefined} aria-pressed={tab==='recent'}
          onClick={()=>setTab('recent')}>Recent</button>
      </div>
      <div className="bell-body">
        {tab==='needs'
          ?<>
             <div className="bell-sec">Pending confirmations · durable
               {items.length>0&&<span className="cnt hot">{items.length}</span>}</div>
             {items.length===0
               ?<div className="bell-i"><div className="bell-m">
                  <div className="bs">Nothing is waiting on you.</div></div></div>
               :items.map(item=><div className="bell-i" key={item.id}>
                  <span className="bell-d" style={{background:'var(--warn)'}}/>
                  <div className="bell-m">
                    <div className="bm">Approve {item.triggerSource||'triggered'} mint</div>
                    <div className="bs">{item.targetType}:{item.targetId}
                      {item.preview?.contractAddress&&<> · {shortAddress(item.preview.contractAddress)}</>}
                      {item.preview?.methodSignature&&<> · {item.preview.methodSignature}</>}</div>
                    <div className="br" style={{marginTop:'7px'}}>
                      <button type="button" className="b p sm" onClick={()=>resolve(item.id,'CONFIRM')}>Approve</button>
                      <button type="button" className="b g sm" onClick={()=>resolve(item.id,'REJECT')}>Reject</button>
                    </div>
                  </div>
                </div>)}
           </>
          :<>
             <div className="bell-sec">Recent · session scratchpad</div>
             {log.length===0
               ?<div className="bell-i"><div className="bell-m">
                  <div className="bs">Nothing recent.</div></div></div>
               :log.map(entry=><div className="bell-i" key={entry.id}>
                  <span className="bell-d" style={{background:DOT_FOR_TYPE[entry.type]||'var(--accent)'}}/>
                  <div className="bell-m">
                    <div className="bm">{entry.message}</div>
                    <div className="bs">{relativeTime(entry.at)}</div>
                    {/* The whole point of the owner's rule: act where you read it. */}
                    {entry.action&&<div className="br" style={{marginTop:'7px'}}>
                      <button type="button" className="b sm" disabled={runningAction===entry.id}
                        onClick={()=>runEntryAction(entry)}>
                        {runningAction===entry.id?'Working…':entry.action.label}</button></div>}
                  </div>
                  {/* Only entries whose call site declared a domain get a chip -- see notify(). */}
                  {entry.category&&CATEGORY_LABELS[entry.category]&&
                    <span className="bell-cat">{CATEGORY_LABELS[entry.category]}</span>}
                </div>)}
           </>}
      </div>
      <div className="bell-act"><p style={{fontSize:'11px',color:'var(--faint)'}}>
        The badge counts pending confirmations only. Recent is a capped session scratchpad — never an inbox.</p></div>
    </div>}
    {!open&&autoPreview&&<div className={`bell-auto-preview bell-log-${autoPreview.type}`} role="status" aria-live="polite" onClick={dismissAutoPreview}>
      <span className="bell-log-dot" aria-hidden="true"/>
      <span className="bell-log-message">{autoPreview.message}</span>
    </div>}
  </div>;}
// Setting a username at all requires a security password to already exist (enforced server-side
// too, see api.js's usernameSet) -- a username with no password behind it could never sign anyone
// in, so the button offering it stays disabled until there's a password for it to pair with.
async function promptSetUsername({isChange,onProfileChange}){
  const value=await promptDialog(isChange
    ?'Choose a new username (3-32 characters: letters, digits, or underscores, starting with a letter).'
    :'Choose a username for username + password sign-in (3-32 characters: letters, digits, or underscores, starting with a letter).',
    {placeholder:'yourname'});
  if(!value)return false;
  try{
    const result=await api('/api/auth/username',{method:'PUT',body:JSON.stringify({username:value})});
    onProfileChange?.(current=>({...current,username:result.username}));
    notify(isChange?'Username changed.':'Username set.',{type:'success'});
    return true;
  }catch(error){notify(error.message,{type:'error'});return false;}
}
function Account({profile,onLogout,onProfileChange}){const [linking,setLinking]=useState(null);async function generate(){try{setLinking(await api('/api/auth/link-code',{method:'POST',body:JSON.stringify({})}));}catch(value){notify(value.message,{type:'error'});}}return <><PageTitle eyebrow="Identity" title="Account" subtitle="One account, shared across Telegram, Discord, and this dashboard."/><div className="card-grid">{profile.linkedAccounts.map(account=><article className="card" key={account.platform}><span className="pill">{account.platform}</span><div className="user-card-identity"><h2>{account.platformUserId}</h2><CopyButton value={account.platformUserId} label="Copy platform user ID"/></div></article>)}</div><div className="panel"><h2>Connect another platform</h2><p>Generate a five-minute, single-use code, then run <code>/link code:&lt;code&gt;</code> in Discord (or <code>/link</code> generates the same kind of code directly from Telegram) to connect it to this same account instead of creating a separate one.</p><button className="panel-cta" onClick={generate}>Generate link code</button>{linking&&<div className="link-code-result"><strong>{linking.code}</strong><p>Expires at {new Date(linking.expiresAt).toLocaleTimeString()}</p></div>}</div><div className="panel"><h2>Login credentials</h2><p>A username and security password together let you sign in with a password instead of a Telegram/Discord code. The same password also gates sensitive actions like exporting a wallet key.</p><div className="account-credential-row"><span>Username</span><strong>{profile.username||'Not set'}</strong><button className="b g sm" disabled={!profile.securityPasswordSet} onClick={()=>promptSetUsername({isChange:Boolean(profile.username),onProfileChange})}>{profile.username?'Change':'Set'}</button></div><div className="account-credential-row"><span>Security password</span><strong>{profile.securityPasswordSet?'Set':'Not set'}</strong><button className="b g sm" onClick={()=>promptSetSecurityPassword({isChange:profile.securityPasswordSet,onProfileChange})}>{profile.securityPasswordSet?'Change':'Set'}</button></div>{!profile.securityPasswordSet&&<p className="notice notice-warning">Set a security password first -- a username needs one to be useful for signing in.</p>}</div>{profile.isOwner&&<div className="panel"><h2>Admin</h2><p>Owner-only controls for groups, ceilings, presets, and platform-wide governance live on a separate screen.</p><a className="b g admin-link panel-cta" href="/dashboard/admin">Open admin dashboard</a></div>}<div className="panel"><h2>Session</h2><p>Signed in {profile.linkedAccounts.map(item=>item.platform).join(' + ')||'as a linked user'}.</p><button className="b g panel-cta" onClick={onLogout}>Log out</button></div></>}
const SUN_ICON=<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/></svg>;
const MOON_ICON=<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>;
const PRIMARY_THEMES=[{value:'ghost-mint-light',label:'Light',icon:SUN_ICON},{value:'ghost-mint',label:'Dark',icon:MOON_ICON}];
const SECONDARY_THEMES=THEME_OPTIONS.filter(option=>option.value!=='ghost-mint'&&option.value!=='ghost-mint-light');
function ThemeSwatch({value}){return <span className={`theme-swatch theme-swatch-${value}`} aria-hidden="true"><span className="theme-swatch-accent"/></span>}
function DefaultChainPanel({profile}){const [value,setValue]=useState(profile.defaultChain||profile.supportedChains[0]);async function change(event){const next=event.target.value;const previous=value;setValue(next);try{await api('/api/profile/default-chain',{method:'PUT',body:JSON.stringify({defaultChain:next})});notify('Default chain saved.',{type:'success'});}catch(error){setValue(previous);notify(error.message,{type:'error'});}}return <div className="panel settings-chain"><div className="settings-panel-heading"><div><p className="eyebrow">Network preference</p><h2>Default chain</h2></div><span className="pill">Account setting</span></div><p>Pre-selects this chain on wallet and scheduled-task forms.</p><ChainSelect name="defaultChain" label="Default chain" options={profile.supportedChains} value={value} onChange={change}/></div>}
function GasPanel({profile}){const [chain,setChain]=useState(profile.defaultChain||profile.supportedChains[0]);const [result,setResult]=useState(null);const [error,setError]=useState('');const [unavailable,setUnavailable]=useState('');const [loading,setLoading]=useState(false);const load=useCallback(async next=>{setLoading(true);setError('');setUnavailable('');setResult(null);try{setResult(await api(`/api/gas/${next}`));}catch(err){if(['MISSING_API_KEY','PROVIDER_ERROR','TIMEOUT','UNAVAILABLE'].includes(err.code))setUnavailable(err.message);else setError(err.message);}finally{setLoading(false);}},[]);useEffect(()=>{load(chain);},[chain,load]);return <div className="panel settings-gas"><div className="settings-panel-heading"><div><p className="eyebrow">Live network data</p><h2>Gas prices</h2></div><ChainSelect name="gasChain" label="Chain" options={profile.supportedChains} value={chain} onChange={e=>setChain(e.target.value)}/></div><p>Etherscan V2 gas oracle. An unavailable provider never blocks the rest of Settings.</p><Notice error={error?{title:'Could not load gas prices.',code:'Request failed safely',onRetry:()=>load(chain)}:null}/>{unavailable&&<p className="notice notice-warning" role="status">{unavailable}</p>}{loading&&<Skeleton variant="lines" rows={1}/>}{result&&<div className="gas-readout"><div><span>Safe</span><strong>{result.safeGasPriceGwei} gwei</strong></div><div><span>Standard</span><strong>{result.gasPriceGwei} gwei</strong></div><div><span>Fast</span><strong>{result.maxFeePerGasGwei} gwei</strong></div></div>}</div>}
// Self-service counterpart to Admin > Mode presets (which edits the four shared preset
// definitions) -- this only ever picks which of those four the signed-in user is currently on,
// same PUT /api/profile/mode -> commands.selectMode every platform's /mode command already calls.
// Display names (Degen/Fast/Cautious/Normie) now come straight from preset.displayName -- the DB
// is the single source of truth (migration 038) so this only needs to carry the extra hint text.
const MODE_HINT={
  ultra_fast:'Fastest, high gas, no confirmation',
  fast:'Quick, higher gas, still confirms',
  semi_safe:'Careful, moderate gas',
  safe:'Slowest, safest, network-price gas',
};
// Must match ADVANCED_PRESET_KEYS in src/governance/postgresGovernanceRepository.js -- the
// backend is the real gate (selectPreset rejects these for an ineligible caller regardless of
// what the UI shows); this list only avoids sending a doomed request and explains why upfront.
const GATED_PRESET_KEYS=['ultra_fast','fast'];
function TransactionModePanel({profile}){
  const presets=useLoad('/api/mode-presets');
  const [current,setCurrent]=useState(profile.currentMode?.key||null);
  const [busy,setBusy]=useState(false);
  const defaultKey=presets.data?.find(preset=>preset.isDefault)?.key;
  async function choose(key){
    if(key===current||busy)return;
    setBusy(true);
    try{await api('/api/profile/mode',{method:'PUT',body:JSON.stringify({preset:key})});setCurrent(key);notify(`Transaction mode set to ${presets.data?.find(preset=>preset.key===key)?.displayName||key}.`,{type:'success'});}
    catch(value){notify(value.message,{type:'error'});}
    finally{setBusy(false);}
  }
  async function resetToDefault(){
    if(!defaultKey||current===defaultKey||busy)return;
    setBusy(true);
    try{await api('/api/profile/mode',{method:'PUT',body:JSON.stringify({preset:null})});setCurrent(defaultKey);notify('Transaction mode reset to the default.',{type:'success'});}
    catch(value){notify(value.message,{type:'error'});}
    finally{setBusy(false);}
  }
  return <div className="panel settings-mode">
    <div className="settings-panel-heading"><div><p className="eyebrow">Speed vs. safety</p><h2>Transaction mode</h2></div>
      <button type="button" className="b g sm" disabled={busy||!defaultKey||current===defaultKey} onClick={resetToDefault}>Reset to default</button>
    </div>
    <p>Controls confirmation prompts and gas aggression for every mint on every platform. Ceilings and forced simulation (Section 7a governance) always take precedence regardless of mode.</p>
    {presets.data===null?<Skeleton variant="lines" rows={1}/>:<div className="card-grid mode-grid">{presets.data.map(preset=>{
      const locked=GATED_PRESET_KEYS.includes(preset.key)&&!profile.advancedModesAllowed;
      return <button type="button" key={preset.key} disabled={busy||locked} title={locked?'Requires group access or a manual admin grant -- ask an owner to enable it.':undefined} className={`mode-card${current===preset.key?' active':''}`} onClick={()=>choose(preset.key)}>
        <strong>{preset.displayName}{preset.isDefault?<span className="pill mode-card-default">Default</span>:null}</strong>
        <span>{MODE_HINT[preset.key]||''}</span>
        <span className="mode-card-detail">Gas × {preset.gasPriceMultiplier} · {preset.humanVerification==='bypass'?'no confirmation':`${preset.confirmationCount} confirmation(s)`}</span>
        {locked&&<span className="mode-card-locked">🔒 Requires access</span>}
      </button>;
    })}</div>}
  </div>;
}
const USAGE_PERIODS=[['today','Today'],['day','24 hours'],['week','7 days'],['month','Month']];
function ApiUsagePanel(){const [period,setPeriod]=useState('month');const usage=useLoad(`/api/social-usage?period=${period}`,[period]);const {data}=usage;return <div className="panel settings-usage"><div className="settings-panel-heading"><div><p className="eyebrow">Owner reporting</p><h2>Social API usage</h2></div><div className="seg usage-period" role="radiogroup" aria-label="Usage period">{USAGE_PERIODS.map(([value,label])=><button type="button" key={value} className={period===value?'on':undefined} aria-pressed={period===value} onClick={()=>setPeriod(value)}>{label}</button>)}</div></div><p>Observed adapter requests, provider-reported consumption, and current pricing estimates.</p><Notice error={loadError(usage,'Could not load social API usage.')}/>{data===null?<Skeleton variant="lines" rows={4}/>:<><div className="usage-stats"><div><span>Total requests</span><strong>{data.requests}</strong></div><div><span>Reported cost</span><strong>${data.reportedCostUsd.toFixed(4)}</strong></div><div><span>Reported credits</span><strong>{data.reportedCredits.toFixed(2)}</strong></div><div><span>Pay-per-use estimate</span><strong>${data.payPerUseEstimateUsd.toFixed(2)}</strong></div><div><span>Projected monthly</span><strong>{Math.round(data.projectedMonthlyRequests).toLocaleString()}</strong></div></div><div className="settings-usage-tables"><div className="table-wrap"><table><thead><tr><th>Rule</th><th>Method</th><th>Type</th><th>Requests</th></tr></thead><tbody>{data.rows.map(row=><tr key={`${row.ruleId}-${row.method}-${row.requestType}`}><td>{row.ruleName}</td><td>{row.method}</td><td>{row.requestType}</td><td>{row.requests}</td></tr>)}</tbody></table>{data.rows.length===0&&<Empty text="No social adapter requests recorded for this period."/>}</div><div className="table-wrap"><table><thead><tr><th>Managed tier</th><th>Break-even reads</th><th>Break-even posts</th></tr></thead><tbody>{data.breakEvenRequests.map(tier=><tr key={tier.price}><td>${tier.price}/mo</td><td>{tier.atReadRate.toLocaleString()}</td><td>{tier.atPostRate.toLocaleString()}</td></tr>)}</tbody></table></div></div></>}</div>}
function Settings({profile,onThemeChange}){const secondaryActive=SECONDARY_THEMES.some(option=>option.value===profile.theme);return <><PageTitle eyebrow="Preferences" title="Settings" subtitle="Display, network defaults, live gas information, and owner reporting."/><div className="settings-layout"><div className="panel settings-appearance"><div className="settings-panel-heading"><div><p className="eyebrow">Display</p><h2>Appearance</h2></div><div className="seg theme-picker" role="radiogroup" aria-label="Dashboard appearance">{PRIMARY_THEMES.map(option=><button type="button" key={option.value} aria-pressed={profile.theme===option.value} className={profile.theme===option.value?'on':undefined} onClick={()=>onThemeChange(option.value)}><span className="theme-picker-icon" aria-hidden="true">{option.icon}</span>{option.label}</button>)}</div></div><details className="settings-more-themes" open={secondaryActive}><summary>More themes</summary><div className="theme-grid" role="radiogroup" aria-label="More dashboard themes">{SECONDARY_THEMES.map(option=><button type="button" key={option.value} aria-pressed={profile.theme===option.value} className={`theme-option${profile.theme===option.value?' active':''}`} onClick={()=>onThemeChange(option.value)}><ThemeSwatch value={option.value}/><span className="theme-option-label">{option.label}</span></button>)}</div></details></div><DefaultChainPanel profile={profile}/><TransactionModePanel profile={profile}/><GasPanel profile={profile}/>{profile.isOwner&&<ApiUsagePanel/>}</div></>}
function Login({onLogin}){
  const [mode,setMode]=useState('code');
  const [code,setCode]=useState('');
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  function chooseMode(next){setMode(next);setError('');}
  async function submitCode(event){event.preventDefault();setBusy(true);setError('');try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({code})});onLogin(await api('/api/profile'));}catch(value){setError(value.message);}finally{setBusy(false);}}
  async function submitPassword(event){event.preventDefault();setBusy(true);setError('');try{await api('/api/auth/login-password',{method:'POST',body:JSON.stringify({username,password})});onLogin(await api('/api/profile'));}catch(value){setError(value.message);}finally{setBusy(false);}}
  return <main className="login-page"><form className="login-card" onSubmit={mode==='code'?submitCode:submitPassword}>
    <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d={BOLT_PATH} fill="currentColor"/></svg></span>
    <p className="eyebrow">Linked identity access</p><h1>GhostMint</h1>
    <div className="seg login-mode-toggle" role="radiogroup" aria-label="Sign-in method">
      <button type="button" aria-pressed={mode==='code'} className={mode==='code'?'on':undefined} onClick={()=>chooseMode('code')}>Authentication code</button>
      <button type="button" aria-pressed={mode==='password'} className={mode==='password'?'on':undefined} onClick={()=>chooseMode('password')}>Username &amp; password</button>
    </div>
    {mode==='code'?<>
      <p>Generate a five-minute code with <code>/link</code> in Telegram, then enter it here. (Discord's <code>/link</code> only consumes a code generated on Telegram — it can't generate one.)</p>
      <label htmlFor="link-code">Link code</label>
      <input id="link-code" value={code} onChange={event=>setCode(event.target.value)} autoComplete="one-time-code" required maxLength="32"/>
    </>:<>
      <p>Sign in with the username and security password set from Account → Login credentials. Not set up yet? Sign in with a code instead, then set them there.</p>
      <label htmlFor="login-username">Username</label>
      <input id="login-username" value={username} onChange={event=>setUsername(event.target.value)} autoComplete="username" required maxLength="32"/>
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password" required maxLength="200"/>
    </>}
    <button className="b p" disabled={busy}>{busy?'Signing in...':'Sign in securely'}</button>
    {error&&<p className="error" role="alert">{error}</p>}
  </form></main>;
}
// Mint = Minting + Tasks (brief §2): "mint now" and "mint at 14:00" are one intent with a time
// field. The two originals are rendered UNCHANGED inside their tabs -- same components, same
// hooks, same routes with the same params. This merge is navigation, not a rewrite, which is what
// keeps it revertible on its own.
//
// `Schedule · was Tasks` carries the retired page name in muted text (brief §2.1, mechanism 1) so
// somebody who knew the old IA can still find it. Drop the "was" labels after a release.
// The preview token's real lifetime, surfaced. /api/mints/preview issues a token valid for 300
// seconds (issuePreview in src/dashboard/api.js) and /api/mints/confirm consumes it exactly once;
// past that the confirm fails with "invalid or expired", which previously arrived as a mystery
// error after the user had already committed to broadcasting.
//
// On expiry the preview is DISCARDED rather than left on screen with a dead button: a stale
// simulation is not evidence about current gas or a still-open mint, and re-simulating is the
// correct action, not retrying a confirm that cannot succeed.
const PREVIEW_TTL_SECONDS=300;
function PreviewExpiry({preview,onExpire,onResimulate}){
  const [remaining,setRemaining]=useState(PREVIEW_TTL_SECONDS);
  useEffect(()=>{
    setRemaining(PREVIEW_TTL_SECONDS);
    const timer=setInterval(()=>setRemaining(value=>{
      if(value<=1){clearInterval(timer);onExpire();return 0;}
      return value-1;
    }),1000);
    return()=>clearInterval(timer);
  },[preview?.previewToken]);
  if(remaining<=0)return null;
  const minutes=Math.floor(remaining/60);
  const seconds=remaining%60;
  // Prototype .tokbar: label, spacer, then the countdown in .tk. Its .warn variant swaps the
  // label for "Quote expired — re-simulate before confirming" and carries a Re-simulate button --
  // the only simulate control the prototype has anywhere.
  return <div className={`tokbar${remaining<=60?' warn':''}`} role="status">
    {CLOCK_ICON}
    {remaining<=60
      ?<><span>Quote expires in</span><span className="sp"/><span className="tk">{minutes}:{String(seconds).padStart(2,'0')}</span>
        <button type="button" className="b sm" onClick={()=>onResimulate?.()}>Re-simulate</button></>
      :<><span>Simulated quote expires in</span><span className="sp"/><span className="tk">{minutes}:{String(seconds).padStart(2,'0')}</span></>}
  </div>;
}

// Batch. Its own panel rather than the free-text "Batch wallet labels" textarea buried in the
// Mint now form, which required typing labels exactly right with no confirmation you had.
// /api/mints/preview and /api/mints/confirm are the SAME routes Mint now uses, with walletLabels
// instead of walletLabel -- no new API surface.
//
// Each wallet reports its OWN outcome. confirm never throws on a single wallet's failure, so one
// bad wallet must not read as a failed batch: results are per row, and a partial success says so.
// /api/wallets returns balances PER CHAIN, never a scalar `balance`. Reading wallet.balance meant
// this list always printed "—" for every wallet and, worse, the low-balance tint could never fire
// -- which is precisely the row the prototype colours --warn-text so a wallet that cannot cover
// the mint is legible before you submit.
function nativeBalance(wallet){
  const rows=wallet?.balances||[];
  const match=rows.find(entry=>entry.chain===wallet.chain)||rows[0];
  if(!match||match.balance===null||match.balance===undefined)return null;
  return {amount:Number(match.balance),symbol:match.symbol||'ETH'};
}
function MintBatch({onGoWallets}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  const [selected,setSelected]=useState([]);
  const [contractAddress,setContractAddress]=useState('');
  const [quantity,setQuantity]=useState('1');
  const [priceEth,setPriceEth]=useState('0');
  const [preview,setPreview]=useState(null);
  const [results,setResults]=useState(null);
  const [busy,setBusy]=useState(false);
  // The prototype batch form carries no price field (mint.html:161-181), so the price is detected
  // from the contract exactly as Mint now does it. lastDetected guards against re-detecting the
  // same address on every keystroke.
  const [detectedPrice,setDetectedPrice]=useState(null);
  const lastDetected=useRef("");
  async function detectPrice(address){
    const trimmed=address.trim();
    if(!ADDRESS_SHAPE.test(trimmed)||trimmed===lastDetected.current)return;
    lastDetected.current=trimmed;
    try{
      const result=await api(`/api/mints/detect?contractAddress=${encodeURIComponent(trimmed)}&quantity=${encodeURIComponent(quantity)}`);
      setDetectedPrice(result.priceKnown?weiToEthDisplay(result.valueWei):"0");
    }catch{setDetectedPrice(null);}
  }
  function autoDetectIfReady(value){detectPrice(value);}
  function toggle(label){setSelected(current=>current.includes(label)?current.filter(item=>item!==label):[...current,label]);}
  async function simulate(event){
    event.preventDefault();
    if(!selected.length){notify('Select at least one wallet.',{type:'error'});return;}
    const valueWei=ethToWei(detectedPrice??"0");
    if(valueWei===null){notify('Could not resolve a price for this contract — check the address.',{type:'error'});return;}
    setBusy(true);
    try{
      setPreview(await api('/api/mints/preview',{method:'POST',body:JSON.stringify({
        walletLabels:selected,contractAddress:contractAddress.trim(),arguments:[],valueWei:valueWei.toString()})}));
      setResults(null);
      notify(`Simulation passed for ${selected.length} wallets — review and confirm.`,{type:'success'});
    }catch(value){
      // The server's own words here are "methodSignature is not one of the supported mint
      // signatures", which is true and useless to whoever pasted the address. It happens for a
      // whole class of real drops -- SeaDrop ones -- because buildMintCall only encodes the
      // audited plain-mint signatures, so batch genuinely cannot do them. Say THAT, and say what
      // still works, rather than naming a field the user never filled in.
      const unsupported=(value.issues||[]).some(issue=>issue.field==='methodSignature');
      notify(unsupported
        ?'This contract uses a mint method batch cannot encode (SeaDrop drops are the usual case). Mint now handles it one wallet at a time.'
        :value.message,{type:'error',timeoutMs:unsupported?12000:5000});
    }
    finally{setBusy(false);}
  }
  async function confirmBatch(){
    if(!await confirmDialog(`Broadcast this mint from ${selected.length} wallets? Each is submitted independently.`))return;
    setBusy(true);
    try{
      const response=await api('/api/mints/confirm',{method:'POST',body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});
      setResults(response.results);
      const failed=response.results.filter(item=>item.status!=='success').length;
      notify(failed?`${response.results.length-failed} of ${response.results.length} submitted; ${failed} failed.`:'All wallets submitted.',{type:failed?'error':'success'});
    }catch(value){notify(value.message,{type:'error'});}
    finally{setBusy(false);}
  }
  // Prototype docs/prototype-pages/mint.html:161-197. .split -- the Batch mint form left, the
  // independence note and result panel right. The prototype's form has three fields only:
  // Contract address, the wallet checkbox list, and Quantity per wallet. There is no price field,
  // so the price comes from detection, exactly as it does on Mint now.
  const walletsArrived=wallets.data!==null&&wallets.data!==undefined;
  const noWallets=walletsArrived&&wallets.data.length<2;
  // Owner's rule: batch with one wallet is not a batch, it is Mint now with extra steps. So the
  // gate is on how many are SELECTED, not how many exist -- the contract address stays inert until
  // there are two, because entering a target you cannot yet act on is the part that felt broken.
  //
  // readOnly rather than disabled on purpose: a disabled input fires no events at all, so clicking
  // it to find out why would tell you nothing. readOnly still looks inert, still refuses typing,
  // and can explain itself.
  const BATCH_MIN_WALLETS=2;
  const enoughSelected=selected.length>=BATCH_MIN_WALLETS;
  const gateMessage=`Select at least ${BATCH_MIN_WALLETS} wallets — batching one wallet is just a single mint.`;
  // No toast. This fired from onFocus AND onClick, so a single click raised TWO of them, and every
  // notify() also writes a bell entry -- one click, four pieces of noise. The rule is already
  // stated permanently under the field, which is the version that cannot be missed or dismissed;
  // a toast repeating it was only ever redundant.
  const resultCount=results?results.length:0;
  const succeeded=results?results.filter(entry=>entry.status==='success').length:0;
  return <div className="split">
    <div className="card">
      <div className="ch"><div className="chip-ico">{BATCH_ICON}</div><h2>Batch mint</h2></div>
      <form className="g" style={{gap:'11px'}} onSubmit={simulate}>
        <label className="fl"><span>Contract address</span>
          <input className={`in mono${detectedPrice?' ok':''}`}
            disabled={noWallets} readOnly={!noWallets&&!enoughSelected}
            aria-describedby={!noWallets&&!enoughSelected?'batch-gate':undefined}
            placeholder={enoughSelected?'0x…':`Select ${BATCH_MIN_WALLETS} wallets first`}
            value={contractAddress}
            onChange={e=>{if(!enoughSelected)return;setContractAddress(e.target.value);autoDetectIfReady(e.target.value);}}/>
          {/* Stated up front as well as on click -- a rule you can only discover by bumping into it
              is a rule the page kept to itself. */}
          {!noWallets&&!enoughSelected&&<div className="fielderr" id="batch-gate">{ALERT_ICON}{gateMessage}</div>}</label>
        <label className="fl"><span>Wallets <span style={{color:'var(--faint)',fontWeight:500}}>· up to 100 unique</span></span>
          {!walletsArrived
            ?<div><div className="sk row"/><div className="sk row"/></div>
            :<div className="g" style={{gap:'6px'}}>
              {wallets.data.map(wallet=>{
                // The prototype tints a wallet whose balance will not cover the mint in
                // --warn-text, so the row that is going to fail is legible before you submit.
                const balance=nativeBalance(wallet);
                const low=balance!==null&&balance.amount<=0;
                return <label key={wallet.label}
                  style={{display:'flex',gap:'8px',alignItems:'center',fontSize:'12.5px',
                    color:low?'var(--warn-text)':undefined}}>
                  <input type="checkbox" style={{minHeight:'auto',width:'16px',height:'16px'}}
                    checked={selected.includes(wallet.label)} onChange={()=>toggle(wallet.label)}/>
                  {wallet.label} — {balance?`${balance.amount.toFixed(3)} ${balance.symbol}`:'balance unavailable'}
                </label>;
              })}
            </div>}
        </label>
        <label className="fl"><span>Quantity per wallet</span>
          <div className="qty">
            <input className="in tab" type="number" min={1} max={3} disabled={noWallets}
              placeholder="Enter quantity (1–3)" value={quantity} onChange={e=>setQuantity(e.target.value)}/>
            {/* Shared rule against this form's cap of 3 -> 1, 2, 3, Max. Backlog §13. */}
            <div className="qb">{quantityPicks(3).map(pick=><button type="button" key={pick} disabled={noWallets}
              className={String(pick)===String(quantity)?'on':undefined}
              onClick={()=>setQuantity(String(pick))}>{pick}</button>)}
              <button type="button" disabled={noWallets}
                className={String(quantity)==='3'?'on':undefined}
                onClick={()=>setQuantity('3')}>Max</button></div>
          </div></label>
        <button className="b p" disabled={busy||!enoughSelected}>Simulate all {selected.length||0}</button>
      </form>
    </div>

    <div className="g">
      <div className="nt i">{INFO_ICON}
        <div>Each wallet is simulated and submitted <b>independently</b>. One wallet failing does not cancel the others.</div></div>
      {busy
        ?<div><div className="sk row"/><div className="sk row"/><div className="sk row"/></div>
        :noWallets
          ?<div className="emp">
             <div className="ei">{WALLET_EMPTY_ICON}</div>
             <h3>No wallets to batch</h3>
             <p>Batch minting needs at least two wallets. Create them first.</p>
             <button type="button" className="b p sm" onClick={()=>onGoWallets?.()}>Create a wallet</button>
           </div>
          :results
            ?<div className="card">
               <div className="ch"><h2>Result</h2><div className="sp"/>
                 <span className={`p ${succeeded===resultCount?'ok':'wn'}`}>{succeeded} of {resultCount} succeeded</span></div>
               {results.map(entry=><div className="bres" key={entry.walletLabel||entry.label}>
                 <span className={`p ${entry.status==='success'?'ok':'bad'}`}>{entry.status==='success'?'Confirmed':'Failed'}</span>
                 <span className="bl2">{entry.walletLabel||entry.label}</span>
                 <span className={entry.status==='success'?'be mono':'be'}>
                   {entry.status==='success'?shortHex(entry.transactionHash||''):entry.error}</span>
               </div>)}
               <p style={{fontSize:'11px',color:'var(--faint)',marginTop:'9px'}}>
                 {succeeded} {succeeded===1?'transaction was':'transactions were'} broadcast.
                 {resultCount-succeeded>0?` The ${resultCount-succeeded===1?'other':'others'} never left the server.`:''}</p>
             </div>
            :preview
              ?<div className="g">
                 <PreviewExpiry preview={preview} onExpire={()=>setPreview(null)} onResimulate={simulate}/>
                 <div className="sober">
                   <div className="sh">{LOCK_ICON}Simulation passed</div>
                   <table className="led"><tbody>
                     {preview.items.map(item=><tr key={item.wallet.label}>
                       <td>{item.wallet.label}</td>
                       <td>{weiToEthDisplay(item.simulation.estimatedCostWei)} ETH</td></tr>)}
                     <tr className="tot"><td>Wallets</td><td>{preview.items.length}</td></tr>
                   </tbody></table>
                 </div>
                 <button type="button" className="b p big bl" disabled={busy} onClick={confirmBatch}>
                   Confirm and mint · {preview.items.length} {preview.items.length===1?'wallet':'wallets'}</button>
               </div>
              :null}
    </div>
  </div>;
}

// Presets: the saved mint configurations, plus the method registry they resolve against. Read-only
// here -- presets are created from the bots, and adding a create form would be a new write path,
// not a restyle.
// Prototype docs/prototype-pages/mint.html:200-232: a .split of "Saved presets" and "Method
// registry". The registry list is static in the design and static here; nothing exposes the
// server's signature table to the dashboard, so it is a reference panel, not live data (noted in
// the backlog so it gets bound if a route ever appears).
// The prototype shows five rows and a "+4 more" summary. The five were hardcoded here to match,
// which meant the page asserted what the encoder supports without ever asking it -- add a
// signature to mintRegistry and this list silently starts lying. It now reads the real table from
// /api/mint-methods, and "+N more" is a control rather than a caption: the owner's ruling is that
// this is reference material consulted MID-FORM, so it expands in place. Sending someone to
// another page to check a signature would abandon a half-filled preset.
const METHOD_PREVIEW_COUNT=5;
function MintPresets({onUsePreset}){
  const presets=useLoad('/api/mint-presets');
  const methods=useLoad('/api/mint-methods');
  const [showAllMethods,setShowAllMethods]=useState(false);
  const items=presets.data;
  const methodRows=methods.data||[];
  const visibleMethods=showAllMethods?methodRows:methodRows.slice(0,METHOD_PREVIEW_COUNT);
  const hiddenMethodCount=Math.max(0,methodRows.length-METHOD_PREVIEW_COUNT);
  return <div className="split">
    <div className="card">
      <div className="ch"><h2>Saved presets</h2><div className="sp"/>
        {items&&items.length>0&&<span className="p nu">{items.length}</span>}</div>
      {presets.error
        ?<Notice error={loadError(presets,'Could not load saved presets.')}/>
        :items===null||items===undefined
          ?<div><div className="sk row"/><div className="sk row"/></div>
          :items.length===0
            ?<div className="emp">
               <div className="ei">{PRESET_ICON}</div>
               <h3>No presets saved</h3>
               <p>A preset stores a contract, method and arguments so a repeat mint is one tap.</p>
             </div>
            :<div>{items.map(preset=><div className="r" key={preset.name}>
                <div className="rm">
                  <div className="rt">{preset.name}</div>
                  <div className="rs mono fold">{preset.methodSignature} · {shortHex(preset.contractAddress)}</div>
                </div>
                <div className="rv"><button type="button" className="b g sm"
                  onClick={()=>onUsePreset?.(preset)}>Use</button></div>
              </div>)}</div>}
    </div>
    <div className="card">
      <div className="ch"><h2>Method registry</h2></div>
      <p style={{fontSize:'12.5px',color:'var(--muted)',marginBottom:'11px'}}>Only audited signatures can be encoded. Arbitrary ABI fragments and raw calldata are rejected.</p>
      <div className="sober">
        <div className="sh">Supported signatures</div>
        {methods.data===null
          ?<div><div className="sk l w80"/><div className="sk l w60"/><div className="sk l w40"/></div>
          :<table className="led">
            <tbody>
              {visibleMethods.map(method=><tr key={method.signature}>
                <td className="mono">{method.signature}</td><td>{method.standard}</td></tr>)}
              {hiddenMethodCount>0&&<tr className="tot">
                <td colSpan={2}>
                  <button type="button" className="b g sm" aria-expanded={showAllMethods}
                    onClick={()=>setShowAllMethods(value=>!value)}>
                    {showAllMethods?'Show fewer':`+${hiddenMethodCount} more`}</button>
                </td></tr>}
            </tbody>
          </table>}
      </div>
    </div>
  </div>;
}

const MINT_TABS=[
  {id:'now',label:'Mint now'},
  {id:'schedule',label:'Schedule',was:'Tasks'},
  {id:'batch',label:'Batch'},
  {id:'presets',label:'Presets'},
];
// Severity, worst first. A red badge on the rail says the Mint page has a problem; these say WHICH
// of its four screens owns it, which is the whole point of putting them on the tabs as well.
//
// Only Schedule can currently carry one, and that is a fact about the data rather than a gap in
// the mechanism: Mint now, Batch and Presets hold no state that outlives the request. A batch
// result and a failed simulation are gone the moment you leave, so a badge for them would have
// nothing to count. The mechanism is general, so any of them can report the day they do.
function scheduleBadge(counts){
  if(!counts)return null;
  const failed=counts.failed||0,expired=counts.expired||0,paused=counts.paused||0;
  const total=failed+expired+paused;
  if(!total)return null;
  return {count:total,tone:failed>0?'bad':expired>0?'wn':'nu'};
}
function Mint({profile,go,tab,onTab}){
  // Falls back to 'now' for an unknown ?tab= rather than rendering an empty page -- a stale or
  // hand-edited tab value should land somewhere useful, not nowhere.
  const active=MINT_TABS.some(item=>item.id===tab)?tab:'now';
  const tasks=useLoad('/api/tasks?page=1&pageSize=1',[],'tasks.changed');
  const badges={schedule:scheduleBadge(tasks.data?.counts)};
  return <>
    <div className="page-head"><div className="page-head-text"><p className="eyebrow">Mint</p><h1>Mint</h1></div></div>
    <SubTabs tabs={MINT_TABS} active={active} onChange={onTab} label="Mint sections" badges={badges}/>
    {active==='now'&&<Minting onSwitchToBatch={()=>onTab('batch')} onGoWallets={()=>go('Wallets')}/>}
    {active==='schedule'&&<Tasks profile={profile} go={go}/>}
    {active==='batch'&&<MintBatch onGoWallets={()=>go('Wallets')}/>}
    {active==='presets'&&<MintPresets onUsePreset={preset=>{setPendingMintPrefill({contractAddress:preset.contractAddress});onTab('now');}}/>}
  </>;
}
// Automation = Snipers + Watch Rules + Target Policies (brief §2). A sniper and a watch rule are
// the same shape -- a source that listens and a mint it can fire -- and a policy has no
// independent existence, so it belongs on its target rather than on a page of its own.
//
// As in unit 1, the three originals render UNCHANGED inside their tabs: same components, same
// hooks, same routes with the same params. No API call changes.
const AUTOMATION_TABS=[
  {id:'snipers',label:'Snipers'},
  {id:'social',label:'Social rules',was:'Watch Rules'},
  {id:'policies',label:'Policies',was:'Target Policies'},
];
function Automation({tab,onTab,target}){
  const active=AUTOMATION_TABS.some(item=>item.id===tab)?tab:'snipers';
  return <>
    <div className="page-head"><div className="page-head-text"><p className="eyebrow">Automation</p><h1>Automation</h1></div></div>
    {/* The post-confirmation disclosure is page-level and unconditional -- it must be visible
        even with zero triggers configured, because it describes what this page's feature IS,
        not what any particular row is doing. Previously it only appeared on sniper cards, so an
        empty Snipers page disclosed nothing at all. */}
    <p className="notice notice-warning" role="note">
      Snipers copy <strong>confirmed</strong> wallet transactions after their confirmation
      threshold. This is not mempool front-running, and nothing here submits before a transaction
      the target made has already confirmed on chain.
    </p>
    <SubTabs tabs={AUTOMATION_TABS} active={active} onChange={onTab} label="Automation sections"/>
    {active==='snipers'&&<Snipers/>}
    {active==='social'&&<WatchRules/>}
    {active==='policies'&&<TargetPolicies target={target}/>}
  </>;
}
// Wallets = Wallets + P&L (brief §2). On its own page P&L was a table the user had to mentally
// join back to their wallets.
//
// Performance is ACCOUNT-level, not per-wallet, and the tab says so: pnl_records has no wallet
// column (contract §5.9), so a per-wallet split cannot be computed and must not be implied.
// Send ships as an explanatory panel, not a form. No dashboard route exists for it (contract
// §5.10) and adding one is a value-moving path that deserves its own review rather than a slot
// in a restyle. So this says plainly where sending DOES work today instead of rendering a
// disabled form that looks like a bug, or worse, one that looks live and silently fails.
function WalletSend(){
  return <div className="panel">
    <h2>Sending is available from the bots, not the dashboard yet</h2>
    <p>The conversational send flow — pick a wallet, enter a destination and an amount, confirm
      against your spending ceiling — runs on Telegram and Discord today. Use <code>/send</code>
      on either platform.</p>
    <p>It is deliberately not duplicated here yet. Moving value is the one path where a second,
      differently-built implementation could disagree with the first, so it gets its own review
      rather than arriving alongside a visual change.</p>
  </div>;
}

// Export. The raw private key NEVER reaches the browser: the server re-encrypts the stored key
// into a standard V3 keystore under the account's security password, and only that encrypted
// blob is returned. This panel deliberately restates that, because "export key" reasonably
// sounds like it hands over the key itself.
function WalletExport({profile,onProfileChange}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  return <>
    <div className="panel">
      <h2>Encrypted keystore export</h2>
      <p>The raw private key is never sent to your browser. The server re-encrypts it into a
        standard V3 keystore file using your security password, and only that encrypted file is
        downloaded.</p>
      <p className="warning">Store the keystore and your security password separately. Together
        they are the wallet; either one alone is not.</p>
      {!profile.securityPasswordSet&&<p className="notice notice-warning">Set a security password
        first — exporting needs one, and it then gates every future sensitive action.</p>}
    </div>
    {wallets.data===null?<Skeleton rows={2}/>
      :wallets.data.length===0?<Empty text="No wallets to export yet."/>
        :<div className="card-grid">{wallets.data.map(wallet=><article className="card" key={wallet.label}>
          <h2>{wallet.label}</h2>
          <div className="user-card-identity"><p className="mono">{wallet.address}</p><CopyButton value={wallet.address} label="Copy wallet address"/></div>
          <div className="br"><button className="b g sm" onClick={()=>exportWalletKeystore(wallet.label,{profile,onProfileChange})}>Export keystore</button></div>
        </article>)}</div>}
  </>;
}

const WALLET_TABS=[
  {id:'balances',label:'Balances'},
  {id:'performance',label:'Performance',was:'P&L'},
  {id:'send',label:'Send'},
  {id:'export',label:'Export'},
];
function WalletsPage({profile,onProfileChange,tab,onTab}){
  const active=WALLET_TABS.some(item=>item.id===tab)?tab:'balances';
  return <>
    <div className="page-head"><div className="page-head-text"><p className="eyebrow">Wallets</p><h1>Wallets</h1></div></div>
    <SubTabs tabs={WALLET_TABS} active={active} onChange={onTab} label="Wallet sections"/>
    {active==='balances'&&<Wallets profile={profile} onProfileChange={onProfileChange}/>}
    {active==='performance'&&<><p className="notice notice-warning" role="note">
      Performance is <strong>account-level</strong>, across every wallet together. Per-wallet
      cost and return cannot be shown: P&amp;L records carry no wallet, so splitting the totals
      would mean inventing an attribution the data does not support.
    </p><Pnl/></>}
    {active==='send'&&<WalletSend/>}
    {active==='export'&&<WalletExport profile={profile} onProfileChange={onProfileChange}/>}
  </>;
}
// History = Activity + the audit surfaces (brief §2). Activity is a mutable feed; audit is
// append-only evidence. They become sibling tabs rather than one being reskinned as the other,
// which is the separation GHOSTMINT_UI_RULES.md requires.
//
// Security log is OWNER-ONLY and the tab is HIDDEN, not disabled, for a regular account:
// /api/security-audit is the PERSONAL feed: scoped to the session's own user server-side, with no
// parameter that could widen it. This tab used to call the owner-gated admin route, so it showed
// every account's events to the owner and 403'd for everyone else. Backlog §13.1.
// (kept: the old note about owner-gating applied to the admin view, which still exists)
// would 403 on load. Offering a control that cannot work is worse than not offering it
// (contract §6.1).
const SECURITY_PAGE_SIZE=20;
function SecurityLogTab(){
  const listing=useLoad('/api/security-audit?limit=200');
  const [page,setPage]=useState(1);
  const rows=listing.data||[];
  // 200 rows in one scroll was the whole list. Paged client-side because the endpoint returns a
  // capped recent window rather than a paginated collection -- the shared Pager still drives it,
  // so it behaves and looks like every other list (§11.3).
  const totalPages=Math.max(1,Math.ceil(rows.length/SECURITY_PAGE_SIZE));
  const shown=rows.slice((page-1)*SECURITY_PAGE_SIZE,page*SECURITY_PAGE_SIZE);
  const pagerValue={page,pageSize:SECURITY_PAGE_SIZE,total:rows.length,totalPages};
  return <>
    <p className="eyebrow">Your recent authorization outcomes across Telegram, Discord and the dashboard — successes, rejections and failures.</p>
    <Notice error={loadError(listing,'Could not load governance data.')}/>
    {listing.data===null?<Skeleton variant="lines" rows={6}/>
      :rows.length===0?<Empty text="No security events recorded yet."/>
        :<><div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Platform</th><th>Command</th><th>Outcome</th><th>Reason</th></tr></thead>
          <tbody>{shown.map(row=><tr key={row.auditId}>
            <td>{new Date(row.attemptedAt).toLocaleString()}</td>
            <td><PlatformChip platform={row.platform}/>{row.platformUserId?` ${row.platformUserId}`:''}</td>
            <td>{row.command}</td>
            {/* Amber for a refusal, which used to render identically to a failure even though the
                two mean different things: refused is the system working, failed is it not. */}
            <td><span className={`p ${outcomeTone(row.outcome)}`}>{row.outcome}</span></td>
            <td>{row.reason}</td>
          </tr>)}</tbody></table></div>
        <Pager value={pagerValue} page={page} setPage={setPage}/></>}
  </>;
}
function History({profile,tab,onTab}){
  // Built from profile.isOwner so the tab list itself differs -- a non-owner never sees a tab
  // they cannot open, and `active` falls back to Activity if a stale ?tab=security is bookmarked
  // by someone who has since lost owner access.
  const tabs=[
    {id:'activity',label:'Activity'},
    {id:'audit',label:'Audit evidence'},
    ...(profile.isOwner?[{id:'security',label:'Security log'}]:[]),
  ];
  const active=tabs.some(item=>item.id===tab)?tab:'activity';
  return <>
    <div className="page-head"><div className="page-head-text"><p className="eyebrow">History</p><h1>History</h1></div></div>
    <SubTabs tabs={tabs} active={active} onChange={onTab} label="History sections"/>
    {active==='activity'&&<Activity/>}
    {active==='audit'&&<div className="panel">
      <h2>Audit evidence is not available on the dashboard yet</h2>
      {/* Honest unavailable state, not a placeholder pretending to be a feature: triggerAudit
          exists in botCommandService but has no dashboard route (contract §5.11). Routing it is
          a src/** change with its own review, so this says where the data IS reachable today
          rather than rendering an empty table that looks like "no evidence exists". */}
      <p>Every automated trigger records append-only evidence — what was detected, which rule
        matched, and what was submitted as a result. That record exists and is intact.</p>
      <p>It is currently reachable only from the bots: run <code>/triggeraudit</code> in Telegram
        or Discord. There is no dashboard route for it yet, and this panel deliberately shows
        nothing rather than an empty table that would read as &ldquo;no evidence recorded&rdquo;.</p>
    </div>}
    {active==='security'&&<SecurityLogTab/>}
  </>;
}
/* ==========================================================================
   Command palette (brief §2.2) — unit 5 of Phase 4.

   HARD CONSTRAINT, and the reason this component holds no api() call at all:
   THE PALETTE NAVIGATES ONLY. It never mutates, never submits a form, never
   triggers a transaction. Every entry below resolves to a go() call — a route
   plus pre-selected state — and the user performs the actual action on the page
   it lands on. "Mint now" goes TO the mint form; it does not mint. If you are
   ever tempted to wire an action handler in here, that is the line.

   The Moved group is what makes the 11->5 merge safe: someone who types "P&L"
   out of habit lands in the right place AND is shown where it now lives, so the
   next search is unnecessary.
   ========================================================================== */
const PALETTE_PAGES=[
  {label:'Home',page:'Home'},
  {label:'Mint',page:'Mint'},
  {label:'Automation',page:'Automation'},
  {label:'Wallets',page:'Wallets'},
  {label:'History',page:'History'},
  {label:'Settings',page:'Settings'},
  {label:'Account',page:'Account'},
];
const PALETTE_MOVED=[
  {label:'Minting',page:'Mint',tab:'now',where:'Mint → Mint now'},
  {label:'Tasks',page:'Mint',tab:'schedule',where:'Mint → Schedule'},
  {label:'Snipers',page:'Automation',tab:'snipers',where:'Automation → Snipers'},
  {label:'Watch Rules',page:'Automation',tab:'social',where:'Automation → Social rules'},
  {label:'Target Policies',page:'Automation',tab:'policies',where:'Automation → Policies'},
  {label:'P&L',page:'Wallets',tab:'performance',where:'Wallets → Performance'},
  {label:'Activity',page:'History',tab:'activity',where:'History → Activity'},
];
const PALETTE_ACTIONS=[
  {label:'Mint now',page:'Mint',tab:'now',where:'Go to the mint form'},
  {label:'Schedule a mint',page:'Mint',tab:'schedule',where:'Go to the schedule form'},
  {label:'Create a wallet',page:'Wallets',tab:'balances',where:'Go to wallet creation'},
  {label:'Create a sniper',page:'Automation',tab:'snipers',where:'Go to sniper creation'},
  {label:'Create a social rule',page:'Automation',tab:'social',where:'Go to watch-rule creation'},
  {label:'View performance',page:'Wallets',tab:'performance',where:'Go to account P&L'},
];
function CommandPalette({open,onClose,go,profile,wallets}){
  const [query,setQuery]=useState('');
  const [active,setActive]=useState(0);
  const inputRef=useRef(null);
  useEffect(()=>{if(open){setQuery('');setActive(0);inputRef.current?.focus();}},[open]);
  const term=query.trim().toLowerCase();
  const match=label=>!term||label.toLowerCase().includes(term);
  const groups=[];
  const pages=PALETTE_PAGES.filter(item=>match(item.label))
    // Admin is owner-only everywhere else; the palette must not advertise a door that opens
    // onto AdminDenied for a regular account.
    .concat(profile.isOwner&&match('Admin')?[{label:'Admin',href:'/dashboard/admin'}]:[]);
  if(pages.length)groups.push({name:'Pages',items:pages});
  const moved=PALETTE_MOVED.filter(item=>match(item.label));
  if(moved.length)groups.push({name:'Moved',items:moved});
  const actions=PALETTE_ACTIONS.filter(item=>match(item.label));
  if(actions.length)groups.push({name:'Actions',items:actions});
  const walletHits=(wallets||[]).filter(wallet=>match(wallet.label)||match(wallet.address||''))
    .slice(0,5).map(wallet=>({label:wallet.label,where:wallet.address,page:'Wallets',tab:'balances'}));
  if(walletHits.length)groups.push({name:'Wallets',items:walletHits});
  const flat=groups.flatMap(group=>group.items);
  const clamped=Math.min(active,Math.max(0,flat.length-1));
  function choose(item){
    if(!item)return;
    onClose();
    // An href entry is a real document navigation (the admin shell is a separate mount), not a
    // go() route -- still navigation, still no mutation.
    if(item.href){window.location.href=item.href;return;}
    go(item.page,item.tab||null);
  }
  function onKeyDown(event){
    if(event.key==='Escape'){event.preventDefault();onClose();}
    else if(event.key==='ArrowDown'){event.preventDefault();setActive(index=>Math.min(flat.length-1,index+1));}
    else if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(0,index-1));}
    else if(event.key==='Enter'){event.preventDefault();choose(flat[clamped]);}
  }
  if(!open)return null;
  let cursor=-1;
  return <div className="palette-backdrop" onClick={onClose}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={event=>event.stopPropagation()}>
      <input ref={inputRef} type="search" className="palette-input" placeholder="Jump to a page, or search what moved…"
        value={query} onChange={event=>{setQuery(event.target.value);setActive(0);}} onKeyDown={onKeyDown}
        aria-label="Search pages and actions"/>
      <div className="palette-results" role="listbox">
        {flat.length===0&&<p className="palette-empty">Nothing matches “{query}”.</p>}
        {groups.map(group=><div className="palette-group" key={group.name}>
          <div className="palette-group-name">{group.name}</div>
          {group.items.map(item=>{cursor+=1;const index=cursor;return <button type="button" key={`${group.name}:${item.label}`}
            role="option" aria-selected={index===clamped}
            className={`palette-item${index===clamped?' active':''}`}
            onMouseEnter={()=>setActive(index)} onClick={()=>choose(item)}>
            <span className="palette-item-label">{item.label}</span>
            {item.where&&<span className="palette-item-where">{item.where}</span>}
          </button>;})}
        </div>)}
      </div>
      <div className="palette-foot">↑↓ to move · Enter to open · Esc to close</div>
    </div>
  </div>;
}
const VIEWS={Home:Dashboard,Mint,Automation,Wallets:WalletsPage,History,Settings,Account};
// Prototype .bbar (ghostmint-redesign-v3.html:2098): FIVE equal columns --
// Home, Mint, Auto, Wallets, More -- and nothing else. The build had Home, Wallets, History, a
// spacer, More, plus a floating circular Mint button hovering above the bar. That FAB is not in
// the design at all: .bbar is grid-template-columns:repeat(5,1fr) with flat buttons whose only
// active treatment is color:var(--accent).
//
// The label is "Auto", not "Automation" -- at 9.5px in a fifth of a phone screen the full word is
// what forced the odd layout in the first place.
const BOTTOM_BAR_PAGES=['Home','Mint','Automation','Wallets'];
const BOTTOM_BAR_LABELS={Automation:'Auto'};
// What the prototype's sheet holds, minus its two prototype-only entries (Auth states, Search).
// Admin is deliberately absent: it lives behind an owner check, and offering a control that
// 403s is worse than not offering it.
const MORE_PAGES=['History','Account','Settings'];
const MORE_ICON=<svg {...ICON_PROPS} fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>;
const CHEVRON_LEFT=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>;
const CHEVRON_RIGHT=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>;
function BottomBar({page,go,onOpenMore,moreOpen}){
  const moreActive=moreOpen||!BOTTOM_BAR_PAGES.includes(page);
  return <nav className="mobile-bottombar" aria-label="Primary">
    {BOTTOM_BAR_PAGES.map(item=><button key={item} type="button"
      aria-current={page===item?'page':undefined} onClick={()=>go(item)}>
      <span className="nav-icon" aria-hidden="true">{NAV_ICONS[item]}</span>
      <span className="nav-label">{BOTTOM_BAR_LABELS[item]||item}</span></button>)}
    <button type="button" aria-current={moreActive?'page':undefined} onClick={onOpenMore}>
      <span className="nav-icon" aria-hidden="true">{MORE_ICON}</span>
      <span className="nav-label">More</span></button>
  </nav>;}
function MoreSheet({open,page,go,onClose}){return <>{open&&<div className="sheet-backdrop" onClick={onClose}/>}<div className={`more-sheet${open?' open':''}`} role="dialog" aria-modal="true" aria-label="More" aria-hidden={!open}>
  <button type="button" className="sheet-handle" aria-label="Close" onClick={onClose}/>
  <h2>More</h2>
  <div className="sheet-grid">{MORE_PAGES.map(item=><button type="button" key={item} aria-current={page===item?'page':undefined} onClick={()=>go(item)}><span className="nav-icon" aria-hidden="true">{NAV_ICONS[item]}</span><span className="nav-label">{item}</span></button>)}</div>
</div></>;}
// Prototype rail badges (ghostmint-redesign-v3.html:641,644): Mint carries a NEUTRAL .cnt and
// Automation a RED .cnt.hot. The tones are the specification, not decoration:
//   .cnt      surface-4 on muted -- "there are things here worth a look"
//   .cnt.hot  loss on white      -- "something is broken and wants you now"
// So Mint counts schedules that have stopped moving (paused, failed, expired) and Automation
// counts triggers that are actually failing. A count of healthy things would make the badge
// permanent, and a permanent badge is wallpaper.
//
// Each source refreshes on the socket event it already owns, so the badges follow the same data
// the pages do rather than a second, drifting copy of it.
function useNavBadges(){
  const tasks=useLoad('/api/tasks?page=1&pageSize=1',[],'tasks.changed');
  const rules=useLoad('/api/watch-rules',[],'watchrules.changed');
  const snipers=useLoad('/api/snipers',[],'snipers.changed');
  const counts=tasks.data?.counts;
  // Mint counts schedules that have STOPPED and want a decision. It escalates to the red .cnt.hot
  // only when one of them actually failed -- paused and expired are states you can live with,
  // a failure is one that broke on its own.
  //
  // Note this is NOT what the untouched prototype draws. There the Mint badge reads 2 and its
  // Scheduled chip also reads "2 pending", so in that frame the badge is the QUEUED count. That
  // reading does not survive contact with real data: this account has 11 queued mints, so the
  // badge would sit at 11 permanently and stop carrying information. A badge that is always on is
  // wallpaper. Owner asked what could turn it red, which only makes sense under this reading.
  const mint=counts?(counts.paused||0)+(counts.failed||0)+(counts.expired||0):0;
  const mintFailing=Boolean(counts&&(counts.failed||0)>0);
  const failingRules=(rules.data?.items||[]).filter(rule=>Number(rule.consecutiveFailures)>0).length;
  // A sniper is failing when its most recent event failed -- an old failure it has since recovered
  // from is history, not an alert.
  const events=snipers.data?.events||[];
  const failingSnipers=(snipers.data?.items||[]).filter(sniper=>{
    const latest=events.find(event=>event.sniperId===sniper.id);
    return latest&&['failed','error','skipped'].includes(String(latest.state||'').toLowerCase());
  }).length;
  return {Mint:mint,Automation:failingRules+failingSnipers,
    hot:{Mint:mintFailing,Automation:true}};
}
const TOP_RAIL_PAGES=['Home','Mint','Automation','Wallets','History'];
// The prototype's .railfoot is Admin, Account, Settings, in that order. Settings had no rail entry
// at all before this pass -- on desktop it was reachable only by URL.
const RAIL_FOOTER_PAGES=['Account','Settings'];
const BOTTOM_RAIL_PAGES=['Account'];
function NavList({items,page,go,className}){return <nav aria-label="Dashboard" className={className}><ul>{items.map(item=><li key={item}><button aria-current={page===item?'page':undefined} onClick={()=>go(item)}><span className="nav-icon" aria-hidden="true">{NAV_ICONS[item]}</span><span className="nav-label">{item}</span></button></li>)}</ul></nav>;}
// Prototype .acct-pop (ghostmint-redesign-v3.html), backlog §2. The avatar used to route straight
// to the Account page, which the backlog says explicitly it must NOT: it opens this.
//
// Only Light and Dark appear in the appearance toggle. The three secondary themes (clean-vault,
// neon-arcade, quiet-ledger) live in Settings and are deliberately absent here -- backlog §2 is
// explicit, and a two-state control that can silently be in a third state would be lying about
// which one is on. Hence neither button is marked .on while a secondary theme is active.
const ACCT_ICONS={
  mode:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z"/></svg>,
  account:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/></svg>,
  settings:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/></svg>,
  logout:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M15 17l5-5-5-5M20 12H9M11 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/></svg>,
  light:<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/></svg>,
  dark:<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>,
};
function AccountMenu({profile,theme,initial,go,onChangeTheme,onLogout}){
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open)return;
    const close=event=>{if(!event.target.closest?.('.account-menu'))setOpen(false);};
    const onKey=event=>{if(event.key==='Escape')setOpen(false);};
    document.addEventListener('click',close);document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('click',close);document.removeEventListener('keydown',onKey);};
  },[open]);
  function choose(action){setOpen(false);action();}
  // The prototype prints "user 4f9c…21ab": the account's own id, elided. It is the one identifier
  // that is the same on Telegram, Discord and here, which is what makes it worth showing at all.
  const id=String(profile.userId||'');
  const shortId=id.length>12?id.slice(0,4)+'…'+id.slice(-4):id;
  const mode=profile.currentMode?.displayName||profile.currentMode?.key||null;
  return <div className="account-menu">
    <button type="button" className="av" aria-haspopup="menu" aria-expanded={open}
      aria-label="Account menu" onClick={()=>setOpen(value=>!value)}>{initial}</button>
    {open&&<div className="acct-pop on" role="menu" aria-label="Account">
      <div className="acct-h">
        <div className="an">{profile.displayName||profile.username||'GhostMint user'}</div>
        {shortId&&<div className="ai mono">user {shortId}</div>}
      </div>
      <button type="button" className="acct-i" role="menuitem" onClick={()=>choose(()=>go('Settings'))}>
        {ACCT_ICONS.mode}<span className="sp">Transaction mode</span>
        {/* Having chosen no mode yet is a real state; the prototype only ever draws a chosen one. */}
        {mode&&<span className="mchip">{mode}</span>}</button>
      <button type="button" className="acct-i" role="menuitem" onClick={()=>choose(()=>go('Account'))}>
        {ACCT_ICONS.account}<span className="sp">Account</span></button>
      <button type="button" className="acct-i" role="menuitem" onClick={()=>choose(()=>go('Settings'))}>
        {ACCT_ICONS.settings}<span className="sp">Settings</span></button>
      <div className="acct-tog"><span className="sp">Appearance</span>
        <div className="tmode">
          <button type="button" className={theme==='ghost-mint-light'?'on':undefined} title="Light"
            aria-label="Light theme" aria-pressed={theme==='ghost-mint-light'}
            onClick={()=>onChangeTheme('ghost-mint-light')}>{ACCT_ICONS.light}</button>
          <button type="button" className={theme==='ghost-mint'?'on':undefined} title="Dark"
            aria-label="Dark theme" aria-pressed={theme==='ghost-mint'}
            onClick={()=>onChangeTheme('ghost-mint')}>{ACCT_ICONS.dark}</button>
        </div></div>
      <button type="button" className="acct-i danger" role="menuitem"
        onClick={()=>choose(onLogout)}>{ACCT_ICONS.logout}<span className="sp">Log out</span></button>
    </div>}
  </div>;
}
function Shell({profile,onLogout,onProfileChange}){const navBadges=useNavBadges();const [route,setRoute]=useState(pageFromLocation);const {page,tab,target}=route;const live=useLiveSocket();
  // A retired slug is rewritten in place with replaceState, not pushState: the dead URL must not
  // become a history entry, or Back from the new page would land on the old slug and redirect
  // straight forward again, trapping the user.
  useEffect(()=>{if(route.redirected)window.history.replaceState(null,'',pathFor(route.page,route.tab,route.target));},[]);
  // Command palette (brief §2.2). The wallet list feeds its Wallets group; it is already loaded
  // and cached by useLoad, so opening the palette costs no extra request.
  const [paletteOpen,setPaletteOpen]=useState(false);
  const paletteWallets=useLoad('/api/wallets',[],'wallets.changed');
  useEffect(()=>{
    function onKey(event){
      // metaKey for macOS, ctrlKey elsewhere. Prevented so the browser's own Ctrl+K
      // (focus-address-bar in several browsers) does not steal it.
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setPaletteOpen(value=>!value);}
    }
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[]);const [navOpen,setNavOpen]=useState(false);const [moreOpen,setMoreOpen]=useState(false);const mobile=useIsMobile();const [theme,setTheme]=useState(profile.theme||'ghost-mint');useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);useEffect(()=>{function onPopState(){setRoute(pageFromLocation());}window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState);},[]);useEffect(()=>{function onMessage(event){if(event.detail?.type==='identity.changed')api('/api/profile').then(onProfileChange).catch(()=>{});}window.addEventListener('ghostmint-ws',onMessage);return()=>window.removeEventListener('ghostmint-ws',onMessage);},[onProfileChange]);async function changeTheme(next){const previous=theme;setTheme(next);try{await api('/api/profile/theme',{method:'PUT',body:JSON.stringify({theme:next})});}catch{setTheme(previous);}}const View=VIEWS[page];const isRail=RAIL_THEMES.has(theme);const viewProfile=profile.theme===theme?profile:{...profile,theme};
  // The prototype's .av carries a single letter ("D" for deon). Nothing in /api/profile is
  // guaranteed non-empty, so this falls through displayName -> username -> userId and only then
  // to a neutral glyph, rather than rendering an empty circle.
  const avatarInitial=(profile.displayName||profile.username||profile.userId||'?').trim().charAt(0).toUpperCase()||'?';// go(page) still behaves exactly as before for all ~40 existing callers; the optional second
  // argument is what lets a redirect, a nav item or (in unit 5) the command palette land on a
  // specific sub-tab. Compared against pathname+search rather than pathname alone, so switching
  // tabs on the same page is a real history entry -- Back from Schedule returns to Mint now
  // instead of leaving the page entirely.
  function go(item,nextTab=null){
    const alias=PAGE_ALIASES[item];
    const page=alias?alias.page:item;
    const tabValue=alias&&nextTab===null?alias.tab:nextTab;
    const path=pathFor(page,tabValue);
    if(`${window.location.pathname}${window.location.search}`!==path)window.history.pushState(null,'',path);
    setRoute({page,tab:tabValue,redirected:false});setNavOpen(false);setMoreOpen(false);window.scrollTo({top:0});
  }
  // Ported verbatim from docs/prototype-pages/_rail.html and the prototype's .top bar. The root is
  // .app, NOT .shell/.rail-shell: dropping those two class names is what stops every `.shell ...`
  // and `.rail-shell ...` rule in styles.css from reaching this subtree, so prototype.css owns the
  // chrome outright without those rules having to be deleted out from under the admin shell, which
  // still renders them. .app is prototype.css's own grid (auto 1fr), and [data-m] is its mobile
  // switch -- the rail hides itself there and .bbar/.more-sheet take over.
  if(isRail)return <div className="app" data-m={mobile?'':undefined}>
    <ConfirmHost/>
    <ToastHost/>
    {/* The prototype's rail is a flex column whose nav buttons are DIRECT children -- wrapping them
        in a <nav><ul> would make them one flex item and collapse the 2px gap, so the landmark goes
        on the aside itself instead. Two ARIA attributes, no structural change. */}
    <aside className="rail" role="navigation" aria-label="Dashboard">
      <div className="brand"><div className="brand-mark">G</div><div className="brand-name">GhostMint</div></div>
      <div className="grp">Operate</div>
      {TOP_RAIL_PAGES.map(item=>{
        const badge=navBadges[item]||0;
        const hot=Boolean(navBadges.hot?.[item]);
        return <button type="button" className="nav" key={item}
          aria-current={page===item?'page':undefined} onClick={()=>go(item)}>
          {RAIL_ICONS[item]}<span className="nav-l">{item}</span>
          {badge>0&&<span className={`cnt${hot?' hot':''}`}
            aria-label={`${badge} ${hot?'failing':'needing attention'}`}>{badge}</span>}
        </button>;
      })}
      <div className="railfoot">
        {/* Admin is unconditional here, matching both the prototype and the data contract §6's
            note that hiding it "makes a legitimate owner think the app broke after a permission
            change"; a non-owner who follows it still lands on AdminDenied. It is a full document
            navigation because the admin shell is a separate mount with its own routing. */}
        <button type="button" className="nav" onClick={()=>{window.location.href='/dashboard/admin';}}>
          {RAIL_ICONS.Admin}<span className="nav-l">Admin</span></button>
        {RAIL_FOOTER_PAGES.map(item=><button type="button" className="nav" key={item} aria-current={page===item?'page':undefined} onClick={()=>go(item)}>
          {RAIL_ICONS[item]}<span className="nav-l">{item}</span></button>)}
      </div>
    </aside>
    <div className="body">
      <div className="top">
        <button type="button" className="cmdk" onClick={()=>setPaletteOpen(true)}>
          {CMDK_ICON}<span>Search or jump to…</span><kbd>⌘K</kbd>
        </button>
        <div className="sp"/>
        {/* .dot is painted var(--gain) by prototype.css. While the socket is still connecting that
            would assert a live link that isn't there, so the dot drops to --faint until it is --
            an inline style, which is how the prototype itself expresses one-off colour. */}
        <div className="livechip"><span className="dot" style={live?undefined:{background:'var(--faint)'}}/> <span aria-live="polite">{live?'Live':'Connecting'}</span></div>
        <NotificationBell/>
        <AccountMenu profile={viewProfile} theme={theme} initial={avatarInitial} go={go}
          onChangeTheme={changeTheme} onLogout={onLogout}/>
      </div>
      <main className="wrap" tabIndex="-1"><View profile={viewProfile} go={go} tab={tab} target={target} onTab={next=>go(page,next)} onThemeChange={changeTheme} onLogout={onLogout} onProfileChange={onProfileChange}/></main>
    </div>
    <BottomBar page={page} go={go} moreOpen={moreOpen} onOpenMore={()=>setMoreOpen(value=>!value)}/>
    <MoreSheet open={moreOpen} page={page} go={go} onClose={()=>setMoreOpen(false)}/>
    <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} go={go} profile={profile} wallets={paletteWallets.data}/>
  </div>;
  const brandMark=<span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d={BOLT_PATH} fill="currentColor"/></svg></span>;
  return <div className={`shell${navOpen?' nav-open':''}`}>
    <ConfirmHost/>
    <ToastHost/>
    <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} go={go} profile={profile} wallets={paletteWallets.data}/>
  <header>
    <div className="header-left"><button className="hamburger" type="button" aria-label="Toggle navigation" aria-expanded={navOpen} onClick={()=>setNavOpen(open=>!open)}><span/><span/><span/></button><a className="brand" href="/dashboard/">{brandMark}GhostMint</a></div>
    <div className="header-right">
      <span className="identity">{profile.linkedAccounts.map(item=>item.platform).join(' + ')||'Linked user'}{profile.isOwner?<span className="owner-badge"> | Owner</span>:null}<span className="status-pill"><span className={`status-dot${live?' live':''}`} aria-hidden="true"/><span aria-live="polite">{live?'Live':'Connecting'}</span></span></span>
      <NotificationBell/>
      <button className="b g" onClick={onLogout}>Log out</button>
    </div>
  </header>
  {navOpen&&<div className="backdrop" onClick={()=>setNavOpen(false)}/>}
  <aside><NavList items={PAGES} page={page} go={go}/></aside>
  <main className="content" tabIndex="-1"><View profile={viewProfile} go={go} tab={tab} target={target} onTab={next=>go(page,next)} onThemeChange={changeTheme} onLogout={onLogout} onProfileChange={onProfileChange}/></main>
  </div>;}
function AdminDenied(){return <main className="login-page"><div className="login-card"><p className="eyebrow">Restricted</p><h1>Admin access required</h1><p>This account is not an owner. Return to the dashboard to continue.</p><a className="b g admin-link" href="/dashboard/">Return to dashboard</a></div></main>;}
const ADMIN_SECTIONS=[
  {id:'Overview',label:'Overview',icon:NAV_ICONS.Dashboard},
  {id:'Groups',label:'Groups',icon:<svg {...ICON_PROPS}><circle cx="9" cy="9" r="2.8"/><circle cx="16" cy="10" r="2.2"/><path d="M4 19c.6-3 2.6-4.7 5-4.7s4.4 1.7 5 4.7M14.5 14.6c2 .3 3.4 1.7 3.9 4.4"/></svg>},
  {id:'Users',label:'Users & ceilings',icon:NAV_ICONS.Account},
  {id:'Effective',label:'Effective lookup',icon:<svg {...ICON_PROPS}><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg>},
  {id:'Presets',label:'Mode presets',icon:<svg {...ICON_PROPS}><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="17" r="1.6" fill="currentColor" stroke="none"/></svg>},
  {id:'Owners',label:'Owner access',icon:<svg {...ICON_PROPS}><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/></svg>},
  {id:'Wallets',label:'Batch import',icon:NAV_ICONS.Wallets},
  {id:'Audit',label:'Sensitive · Audit log',icon:<svg {...ICON_PROPS}><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>},
  {id:'Health',label:'System health',icon:<svg {...ICON_PROPS}><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>},
];
const ADMIN_SLUGS={Overview:'',Groups:'groups',Users:'users',Effective:'effective',Presets:'presets',Owners:'owners',Wallets:'wallets',Audit:'audit',Health:'health'};
const SLUG_ADMIN_SECTIONS=Object.fromEntries(Object.entries(ADMIN_SLUGS).map(([section,slug])=>[slug,section]));
function adminSectionFromLocation(){const segment=window.location.pathname.replace(/^\/dashboard\/admin\/?/,'').replace(/\/+$/,'');return SLUG_ADMIN_SECTIONS[segment]||'Overview';}
const ADMIN_MOBILE_PRIMARY=['Overview','Groups','Users'];
const ADMIN_MOBILE_MORE=['Effective','Presets','Owners','Wallets','Audit','Health'];
function AdminNav({page,go}){return <nav aria-label="Admin sections" className="rail-main-nav"><ul>{ADMIN_SECTIONS.map(section=><li key={section.id}><button aria-current={page===section.id?'page':undefined} onClick={()=>go(section.id)}><span className="nav-icon" aria-hidden="true">{section.icon}</span><span className="nav-label">{section.label}</span></button></li>)}</ul></nav>}
function AdminBottomBar({page,go,moreOpen,onOpenMore}){return <nav className="mobile-bottombar admin-mobile-bottombar" aria-label="Admin primary">{ADMIN_MOBILE_PRIMARY.map(id=>{const item=ADMIN_SECTIONS.find(section=>section.id===id);return <button key={id} type="button" aria-current={page===id?'page':undefined} onClick={()=>go(id)}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></button>})}<button type="button" aria-current={moreOpen||ADMIN_MOBILE_MORE.includes(page)?'page':undefined} onClick={onOpenMore}><span className="nav-icon" aria-hidden="true">{MORE_ICON}</span><span className="nav-label">More</span></button></nav>}
function AdminMoreSheet({open,page,go,onClose,onLogout}){return <>{open&&<div className="sheet-backdrop" onClick={onClose}/>}<div className={`more-sheet admin-more-sheet${open?' open':''}`} role="dialog" aria-modal="true" aria-label="More admin pages" aria-hidden={!open}><button type="button" className="sheet-handle" aria-label="Close" onClick={onClose}/><h2>More admin pages</h2><div className="sheet-grid">{ADMIN_MOBILE_MORE.map(id=>{const item=ADMIN_SECTIONS.find(section=>section.id===id);return <button type="button" key={id} aria-current={page===id?'page':undefined} onClick={()=>go(id)}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></button>})}</div><div className="admin-sheet-actions"><a className="b g admin-link" href="/dashboard/">Back to user dashboard</a><button className="b g" onClick={onLogout}>Log out</button></div></div></>}
function ScrollTop(){const [visible,setVisible]=useState(false);useEffect(()=>{const update=()=>setVisible(window.scrollY>480);update();window.addEventListener('scroll',update,{passive:true});return()=>window.removeEventListener('scroll',update);},[]);return visible?<button type="button" className="scroll-top" aria-label="Scroll to top" onClick={()=>window.scrollTo({top:0,behavior:'smooth'})}>↑</button>:null;}
function AdminShell({profile,onLogout}){const theme=profile.theme||'ghost-mint';const [page,setPage]=useState(adminSectionFromLocation());const [moreOpen,setMoreOpen]=useState(false);const [railExpanded,setRailExpandedState]=useState(readRailExpanded);function setRailExpanded(next){setRailExpandedState(value=>{const resolved=typeof next==='function'?next(value):next;writeRailExpanded(resolved);return resolved;});}const live=useLiveSocket();
  // Transient (not URL-based, unlike the section itself) -- which of the 4 user-related stat
  // cards on Overview brought the admin here, so Users can drill down instead of showing the same
  // unfiltered list no matter which card was clicked. Cleared on any navigation away from Users.
  const [usersFilter,setUsersFilter]=useState(null);
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);useEffect(()=>{function onPopState(){setPage(adminSectionFromLocation());}window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState);},[]);if(!profile.isOwner)return <AdminDenied/>;function go(next,filter){const slug=ADMIN_SLUGS[next];const path=slug?`/dashboard/admin/${slug}`:'/dashboard/admin';if(window.location.pathname!==path)window.history.pushState(null,'',path);setPage(next);setUsersFilter(next==='Users'?filter||null:null);setMoreOpen(false);window.scrollTo({top:0});}const brandMark=<span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d={BOLT_PATH} fill="currentColor"/></svg></span>;return <div className={`shell rail-shell admin-shell${moreOpen?' more-open':''}`} data-rail={railExpanded?'expanded':'collapsed'}><ConfirmHost/><ToastHost/><header className="rail-mobile-header"><a className="brand" href="/dashboard/admin" onClick={event=>{event.preventDefault();go('Overview');}}>{brandMark}GhostMint Admin</a><div className="header-right"><span className="status-pill"><span className={`status-dot${live?' live':''}`} aria-hidden="true"/><span aria-live="polite">{live?'Live':'Connecting'}</span></span><NotificationBell/><a className="header-avatar" aria-label="Return to user dashboard" href="/dashboard/">{NAV_ICONS.Account}</a></div></header><aside><div className="rail-top"><a className="brand" href="/dashboard/admin" onClick={event=>{event.preventDefault();go('Overview');}}>{brandMark}<span className="nav-label">GhostMint Admin</span></a></div><AdminNav page={page} go={go}/><nav className="rail-bottom-nav" aria-label="Admin account"><ul><li><a className="admin-rail-link" href="/dashboard/"><span className="nav-icon" aria-hidden="true">{CHEVRON_LEFT}</span><span className="nav-label">User dashboard</span></a></li><li><button onClick={onLogout}><span className="nav-icon" aria-hidden="true">{NAV_ICONS.Account}</span><span className="nav-label">Log out</span></button></li></ul></nav></aside><button type="button" className="rail-edge-toggle" aria-label={railExpanded?'Collapse sidebar':'Expand sidebar'} onClick={()=>setRailExpanded(value=>!value)}>{railExpanded?CHEVRON_LEFT:CHEVRON_RIGHT}</button><div className="notification-bell-desktop"><NotificationBell/></div><main className="content admin-content" tabIndex="-1"><Admin profile={profile} section={page} go={go} usersFilter={usersFilter}/></main><AdminBottomBar page={page} go={go} moreOpen={moreOpen} onOpenMore={()=>setMoreOpen(value=>!value)}/><AdminMoreSheet open={moreOpen} page={page} go={go} onClose={()=>setMoreOpen(false)} onLogout={onLogout}/><ScrollTop/></div>;}
function isAdminPath(){const path=window.location.pathname.replace(/\/+$/,'');return path==='/dashboard/admin'||path.startsWith('/dashboard/admin/');}
export default function App(){const [profile,setProfile]=useState(undefined);const [,forceRender]=useState(0);useEffect(()=>{api('/api/profile').then(setProfile).catch(()=>setProfile(null));},[]);useEffect(()=>{function onPopState(){forceRender(count=>count+1);}window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState);},[]);async function logout(){await api('/api/auth/logout',{method:'POST'});setProfile(null);}if(profile===undefined)return <main className="loading" aria-live="polite">Loading secure session...</main>;if(!profile)return <Login onLogin={setProfile}/>;if(isAdminPath())return <AdminShell profile={profile} onLogout={logout}/>;return <Shell profile={profile} onLogout={logout} onProfileChange={setProfile}/>;}