/* global clearInterval, setInterval */
import React,{useEffect,useMemo,useState} from 'react';
import {api,CopyButton,Notice,Pager,relativeTime,SearchField,SelectMenu,Skeleton,useLoad} from './shared.jsx';
import {buildWalletHistoryPath,formatRawUnits,parseWalletHistorySearch,
  walletHistoryCoverageMeta,walletHistorySourceMeta,walletHistoryStatusMeta,
  walletHistoryTransactionSummary} from './walletHistoryDisplay.mjs';

export const WALLET_HISTORY_SOURCE_OPTIONS=[
  {value:'all',label:'All sources'},
  {value:'ghostmint',label:'GhostMint'},
  {value:'external',label:'External'},
  {value:'source_unknown',label:'Source unknown'},
];
export const WALLET_HISTORY_STATUS_OPTIONS=[
  {value:'all',label:'All outcomes'},
  {value:'success',label:'Succeeded'},
  {value:'reverted',label:'Reverted'},
  {value:'unknown',label:'Status unknown'},
];
export const WALLET_HISTORY_TYPE_OPTIONS=[
  {value:'all',label:'All activity'},
  {value:'mint',label:'Mints'},
  {value:'erc721',label:'NFTs · ERC-721'},
  {value:'erc1155',label:'NFTs · ERC-1155'},
  {value:'erc20',label:'Tokens · ERC-20'},
  {value:'native',label:'Native currency'},
  {value:'approval',label:'Approvals'},
];
const REFRESH_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>;
const EXTERNAL_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>;

function shortHash(value){
  const text=String(value||'');
  return text.length>14?`${text.slice(0,8)}…${text.slice(-5)}`:text;
}

function occurredText(value){
  const time=new Date(value).getTime();
  return Number.isFinite(time)?relativeTime(time):null;
}

export function coverageStateLabel(state){
  return ({not_started:'Not loaded',queued:'Queued',backfilling:'Loading',current:'Current',
    partial:'Partial',unsupported:'Unavailable',error:'Failed'}[state]||'Unknown');
}

export function coverageStateTone(state){
  if(state==='current')return 'ok';
  if(state==='queued'||state==='backfilling')return 'info';
  if(state==='partial'||state==='error')return 'wn';
  return 'nu';
}

export function WalletHistoryRow({item,chainLabel,explorerForChain,nativeSymbolForChain,
  showWallet=false}){
  const symbol=nativeSymbolForChain(item.chain)||'native token';
  const summary=walletHistoryTransactionSummary(item,{nativeSymbol:symbol});
  const source=walletHistorySourceMeta(item.source);
  const status=walletHistoryStatusMeta(item);
  const metadata=[showWallet?item.walletLabel:null,chainLabel(item.chain),shortHash(item.txHash),summary.amountLabel,
    summary.counterparty?`With ${summary.counterparty}`:null,
    summary.extraMovementCount?`+${summary.extraMovementCount} more movement${summary.extraMovementCount===1?'':'s'}`:null,
    occurredText(item.occurredAt)].filter(Boolean);
  const fee=item.networkFeeWei===null||item.networkFeeWei===undefined?'':
    `${formatRawUnits(item.networkFeeWei,18)} ${symbol} network fee`;
  const explorer=explorerForChain(item.chain);
  const href=explorer&&item.txHash?`${explorer}${item.txHash}`:null;
  return <div className="r wallet-history-row">
    <div className="rm">
      <div className="wallet-history-title"><span className="rt">{summary.title}</span>
        <span className={`p ${source.tone}`}>{source.label}</span></div>
      <div className="rs mono">{metadata.join(' · ')}</div>
      {fee&&<div className="wallet-history-fee mono">{fee}</div>}
    </div>
    <div className="rv wallet-history-outcome">
      <span className={`p ${status.tone}`}>{status.label}</span>
      {item.txHash&&<CopyButton value={item.txHash} label={`Copy transaction ${shortHash(item.txHash)}`}/>}
      {href&&<a className="ico-btn" href={href} target="_blank" rel="noopener noreferrer"
        aria-label={`View ${shortHash(item.txHash)} on the block explorer`} title="View on explorer">{EXTERNAL_ICON}</a>}
    </div>
  </div>;
}

export default function WalletHistory({wallet,supportedChains=[],chainLabel=value=>value,
  explorerForChain=()=>null,nativeSymbolForChain=()=>''}){
  const [page,setPage]=useState(1);
  const [snapshotAt,setSnapshotAt]=useState(null);
  const [filters,setFilters]=useState({chain:'',source:'all',status:'all',type:'all'});
  const [searchDraft,setSearchDraft]=useState('');
  const [search,setSearch]=useState(()=>parseWalletHistorySearch(''));
  const [searchError,setSearchError]=useState('');
  const [refreshSequence,setRefreshSequence]=useState(0);
  const [syncBusy,setSyncBusy]=useState(false);
  const [syncPending,setSyncPending]=useState(false);
  const [syncUnavailable,setSyncUnavailable]=useState(false);
  const [syncError,setSyncError]=useState('');
  const PAGE_SIZE=10;
  const path=wallet?.id?buildWalletHistoryPath(wallet.id,{page,pageSize:PAGE_SIZE,...filters,
    search,snapshotAt}):null;
  const listing=useLoad(path,[refreshSequence]);
  // useLoad intentionally retains the prior result during an ordinary refresh. A filter/page path
  // change is different: showing the old rows under new controls is false, so withhold them until
  // that exact path has settled.
  const historyData=listing.dataPath===path?listing.data:null;
  const currentError=listing.resolvedPath===path?listing.error:'';
  const coverage=walletHistoryCoverageMeta(historyData?.coverage);
  const rows=historyData?.items||[];
  const initialLoading=Boolean(wallet?.id)&&historyData===null&&!currentError;
  const polling=!currentError&&coverage.polling;
  const chainOptions=useMemo(()=>{
    const values=[...new Set([...(supportedChains||[]),wallet?.chain,
      ...(wallet?.balances||[]).map(item=>item.chain)].filter(Boolean))];
    return [{value:'',label:'All networks'},...values.map(value=>({value,label:chainLabel(value)}))];
  },[supportedChains,wallet?.chain,wallet?.balances,chainLabel]);

  function resetSnapshot(){
    setPage(1);setSnapshotAt(null);
  }
  function changeFilter(name,value){
    setFilters(current=>({...current,[name]:value}));resetSnapshot();
  }
  function updateSearchDraft(value){
    setSearchDraft(value);setSearchError('');
    if(value===''){setSearch(parseWalletHistorySearch(''));resetSnapshot();}
  }
  function applySearch(event){
    event.preventDefault();
    const parsed=parseWalletHistorySearch(searchDraft);
    if(!parsed.valid){setSearchError(parsed.error);return;}
    setSearch(parsed);setSearchError('');resetSnapshot();
  }
  function changePage(next){
    if(!snapshotAt&&historyData?.snapshotAt)setSnapshotAt(historyData.snapshotAt);
    setPage(next);
  }
  function reloadLatest(){
    resetSnapshot();setRefreshSequence(value=>value+1);
  }
  async function requestSync(){
    if(!wallet?.id||syncBusy)return;
    setSyncBusy(true);setSyncError('');setSyncUnavailable(false);
    try{
      const result=await api(`/api/wallets/${encodeURIComponent(wallet.id)}/history/sync`,{
        method:'POST',body:JSON.stringify(filters.chain?{chain:filters.chain}:{})});
      if(result?.accepted===false){setSyncUnavailable(true);setSyncPending(false);return;}
      setSyncPending(true);reloadLatest();
    }catch(error){
      setSyncPending(false);
      if(error?.status===503)setSyncUnavailable(true);
      else setSyncError('Wallet history could not start updating. The wallet and its funds are unaffected.');
    }finally{setSyncBusy(false);}
  }

  useEffect(()=>{
    const listener=event=>{
      if(event.detail?.type==='wallet-history.changed'||event.detail?.type==='ws.reconnected')reloadLatest();
    };
    window.addEventListener('ghostmint-ws',listener);
    return()=>window.removeEventListener('ghostmint-ws',listener);
  },[wallet?.id]);
  useEffect(()=>{
    if(!(polling||syncPending)||currentError)return undefined;
    const timer=setInterval(()=>listing.load(),4_500);
    return()=>clearInterval(timer);
  },[polling,syncPending,currentError,listing.load]);
  useEffect(()=>{
    if(syncPending&&currentError)setSyncPending(false);
    else if(syncPending&&coverage.state!=='not_started'&&!polling)setSyncPending(false);
  },[syncPending,currentError,coverage.state,polling]);
  useEffect(()=>{
    if(!historyData)return;
    setSyncError('');setSyncUnavailable(false);
  },[historyData]);

  if(!wallet?.id)return <div className="nt w" role="status"><div className="nb"><b>Wallet history is not available yet.</b>{' '}
    This server has not supplied the wallet history identifier. The wallet and its balance are unaffected.</div></div>;

  const coverageTitle=syncUnavailable?'Full wallet history is not available on this server yet.':
    syncError?'Wallet history could not start updating.':coverage.title;
  const coverageDetail=syncUnavailable?'Your wallet and its funds are unaffected. You can try again after history sync is enabled.':
    syncError||coverage.detail;
  const refreshLabel=syncBusy?'Starting…':(polling||syncPending)?'Updating…':
    coverage.state==='not_started'?'Load history':'Refresh';
  const hasFilters=Boolean(filters.chain||filters.source!=='all'||filters.status!=='all'
    ||filters.type!=='all'||search.value);
  const emptyTitle=hasFilters?'No matching transactions':
    coverage.state==='current'?'No on-chain transactions found':
    coverage.state==='unsupported'?'History is unavailable for this network':
    coverage.state==='error'?'History could not be loaded':
    coverage.state==='partial'||coverage.state==='mixed'?'No transactions in the loaded history':
    coverage.state==='queued'||coverage.state==='backfilling'?'No transactions loaded yet':
    'History has not been loaded';
  const emptyDetail=hasFilters?'Try clearing a filter or searching another address or transaction hash.':
    coverage.state==='current'?'No public on-chain transactions were found in the tracked history for this wallet.':
    coverage.state==='unsupported'?'This server does not have a history provider for the selected network.':
    coverage.state==='error'?'Try the refresh again. The wallet and its funds are unaffected.':
    coverage.state==='partial'||coverage.state==='mixed'?'No matching transactions are present in the portion loaded so far.':
    coverage.state==='queued'||coverage.state==='backfilling'?'GhostMint is still loading this wallet history.':
    'Load wallet history to look for activity on supported networks.';

  return <div className="wallet-history" aria-busy={initialLoading||syncBusy||polling||syncPending||undefined}>
    {!currentError&&!initialLoading&&<div className={`wallet-history-coverage ${coverage.tone}`} role="status">
      <div className="wallet-history-coverage-copy"><b>{coverageTitle}</b><span>{coverageDetail}</span></div>
      <button type="button" className="b sm" onClick={requestSync} disabled={syncBusy||polling||syncPending}>
        {REFRESH_ICON}{refreshLabel}</button>
    </div>}
    {!currentError&&!initialLoading&&Array.isArray(historyData?.coverage?.chains)&&historyData.coverage.chains.length>0&&
      <div className="wallet-history-chain-coverage" aria-label="History coverage by network">
        {historyData.coverage.chains.map(item=><span className={`p ${coverageStateTone(item.state)}`}
          key={`${item.chain}:${item.state}`}>{chainLabel(item.chain)} · {coverageStateLabel(item.state)}</span>)}
      </div>}

    <div className="wallet-history-filters">
      <SelectMenu label="Network" options={chainOptions} value={filters.chain}
        onChange={event=>changeFilter('chain',event.target.value)}/>
      <SelectMenu label="Source" options={WALLET_HISTORY_SOURCE_OPTIONS} value={filters.source}
        onChange={event=>changeFilter('source',event.target.value)}/>
      <SelectMenu label="Outcome" options={WALLET_HISTORY_STATUS_OPTIONS} value={filters.status}
        onChange={event=>changeFilter('status',event.target.value)}/>
      <SelectMenu label="Activity type" options={WALLET_HISTORY_TYPE_OPTIONS} value={filters.type}
        onChange={event=>changeFilter('type',event.target.value)}/>
    </div>
    <form className="wallet-history-search" onSubmit={applySearch} noValidate>
      <SearchField label="Address or transaction" value={searchDraft} onChange={updateSearchDraft}
        placeholder="0x address or transaction hash" ariaInvalid={Boolean(searchError)}
        ariaDescribedBy={searchError?'wallet-history-search-error':undefined}/>
      <button type="submit" className="b sm">Search</button>
    </form>
    {searchError&&<p id="wallet-history-search-error" className="fielderr wallet-history-search-error"
      role="alert">{searchError}</p>}

    <Notice error={currentError?{title:'Could not load this wallet history.',
      detail:'The wallet and its funds are unaffected — this is a read failure only.',
      code:'Request failed safely',onRetry:listing.load}:null}/>
    {initialLoading&&<Skeleton rows={4} variant="row"/>}
    {!initialLoading&&!currentError&&rows.length>0&&<div className="card wallet-history-list">
      {rows.map(item=><WalletHistoryRow key={`${item.chain}:${item.txHash}`} item={item}
        chainLabel={chainLabel} explorerForChain={explorerForChain}
        nativeSymbolForChain={nativeSymbolForChain}/>)}</div>}
    {!initialLoading&&!currentError&&rows.length===0&&<div className="card"><div className="emp">
      <h3>{emptyTitle}</h3><p>{emptyDetail}</p>
    </div></div>}
    <Pager value={historyData} page={page} setPage={changePage} visibleCount={rows.length}/>
  </div>;
}
