/* global clearInterval, setInterval */
import React,{useEffect,useMemo,useState} from 'react';
import {Notice,Pager,SearchField,SelectMenu,Skeleton,useLoad} from './shared.jsx';
import {buildAccountWalletHistoryPath,parseWalletHistorySearch,
  walletHistoryCoverageMeta} from './walletHistoryDisplay.mjs';
import {coverageStateLabel,coverageStateTone,WALLET_HISTORY_SOURCE_OPTIONS,
  WALLET_HISTORY_STATUS_OPTIONS,WALLET_HISTORY_TYPE_OPTIONS,WalletHistoryRow} from './WalletHistory.jsx';

function shortAddress(value){
  const text=String(value||'');
  return text.length>12?`${text.slice(0,6)}…${text.slice(-4)}`:text;
}

function coverageEntryLabel(item,chainLabel){
  const wallet=item.walletLabel||shortAddress(item.walletAddress)||'Wallet';
  return `${wallet} · ${chainLabel(item.chain)} · ${coverageStateLabel(item.state)}`;
}

export default function AccountWalletHistory({supportedChains=[],chainLabel=value=>value,
  explorerForChain=()=>null,nativeSymbolForChain=()=>''}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  const [page,setPage]=useState(1);
  const [snapshotAt,setSnapshotAt]=useState(null);
  const [filters,setFilters]=useState({walletId:'',chain:'',source:'all',status:'all',type:'all'});
  const [searchDraft,setSearchDraft]=useState('');
  const [search,setSearch]=useState(()=>parseWalletHistorySearch(''));
  const [searchError,setSearchError]=useState('');
  const PAGE_SIZE=10;
  const path=buildAccountWalletHistoryPath({page,pageSize:PAGE_SIZE,...filters,search,snapshotAt});
  const listing=useLoad(path,[],'wallet-history.changed');
  const historyData=listing.dataPath===path?listing.data:null;
  const currentError=listing.resolvedPath===path?listing.error:'';
  const coverage=walletHistoryCoverageMeta(historyData?.coverage);
  const polling=!currentError&&coverage.polling;
  const rows=historyData?.items||[];
  const initialLoading=historyData===null&&!currentError;
  const walletOptions=useMemo(()=>[
    {value:'',label:'All wallets'},
    ...((wallets.data||[]).filter(item=>Number.isSafeInteger(Number(item?.id))&&Number(item.id)>0)
      .map(item=>({value:String(item.id),label:item.label||shortAddress(item.address)||'Wallet',
        description:shortAddress(item.address)}))),
  ],[wallets.data]);
  const chainOptions=useMemo(()=>[
    {value:'',label:'All networks'},
    ...[...new Set((supportedChains||[]).filter(Boolean))]
      .map(value=>({value,label:chainLabel(value)})),
  ],[supportedChains,chainLabel]);
  const coverageEntries=Array.isArray(historyData?.coverage?.chains)
    ?historyData.coverage.chains:[];
  const hasFilters=Boolean(filters.walletId||filters.chain||filters.source!=='all'
    ||filters.status!=='all'||filters.type!=='all'||search.value);

  function resetSnapshot(){setPage(1);setSnapshotAt(null);}
  function changeFilter(name,value){setFilters(current=>({...current,[name]:value}));resetSnapshot();}
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

  useEffect(()=>{
    if(!polling)return undefined;
    const timer=setInterval(()=>listing.load(),4_500);
    return()=>clearInterval(timer);
  },[polling,listing.load]);

  const coverageDetail=coverage.state==='not_started'
    ?'Open a wallet’s Transactions view to load public on-chain activity. Until then, no completeness claim is made.'
    :coverage.state==='error'
      ?'Open the affected wallet to retry. Your wallets and funds are unaffected.'
      :coverage.detail;
  const emptyTitle=hasFilters?'No matching transactions':coverage.state==='current'
    ?'No on-chain transactions found':'No transactions loaded yet';
  const emptyDetail=hasFilters?'Try clearing a filter or searching another address or transaction hash.'
    :coverage.state==='current'
      ?'No public on-chain transactions were found in the tracked history for these wallets.'
      :'Open a wallet’s Transactions view to load history for supported networks.';

  return <div className="wallet-history account-wallet-history"
    aria-busy={initialLoading||polling||undefined}>
    {!currentError&&!initialLoading&&<div className={`wallet-history-coverage ${coverage.tone}`} role="status">
      <div className="wallet-history-coverage-copy"><b>{coverage.title}</b>
        <span>{coverageDetail}</span></div>
    </div>}
    {!currentError&&!initialLoading&&coverageEntries.length>0&&<details
      className="wallet-history-coverage-details">
      <summary>Coverage by wallet and network</summary>
      <div className="wallet-history-chain-coverage">
        {coverageEntries.map((item,index)=><span className={`p ${coverageStateTone(item.state)}`}
          key={`${item.walletId||item.walletAddress}:${item.chain}:${index}`}>
          {coverageEntryLabel(item,chainLabel)}</span>)}
      </div>
    </details>}

    <div className="wallet-history-filters account-wallet-history-filters">
      <SelectMenu label="Wallet" options={walletOptions} value={filters.walletId}
        disabled={wallets.data===null||Boolean(wallets.error)}
        onChange={event=>changeFilter('walletId',event.target.value)}/>
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
      <SearchField id="account-wallet-history-search" label="Address or transaction"
        value={searchDraft} onChange={updateSearchDraft} placeholder="0x address or transaction hash"
        ariaInvalid={Boolean(searchError)}
        ariaDescribedBy={searchError?'account-wallet-history-search-error':undefined}/>
      <button type="submit" className="b sm">Search</button>
    </form>
    {searchError&&<p id="account-wallet-history-search-error"
      className="fielderr wallet-history-search-error" role="alert">{searchError}</p>}

    <Notice error={wallets.error?{title:'Could not load your wallet names.',
      detail:'Transactions can still load, but the wallet filter is temporarily unavailable.',
      code:'Request failed safely',onRetry:wallets.load}:null}/>
    <Notice error={currentError?{title:'Could not load on-chain transactions.',
      detail:'Your wallets and transactions are unaffected — this is a read failure only.',
      code:'Request failed safely',onRetry:listing.load}:null}/>
    {initialLoading&&<Skeleton rows={4} variant="row"/>}
    {!initialLoading&&!currentError&&rows.length>0&&<div className="card wallet-history-list">
      {rows.map(item=><WalletHistoryRow
        key={`${item.walletAddress}:${item.chain}:${item.txHash}`} item={item} showWallet
        chainLabel={chainLabel} explorerForChain={explorerForChain}
        nativeSymbolForChain={nativeSymbolForChain}/>)}</div>}
    {!initialLoading&&!currentError&&rows.length===0&&<div className="card"><div className="emp">
      <h3>{emptyTitle}</h3><p>{emptyDetail}</p>
    </div></div>}
    <Pager value={historyData} page={page} setPage={changePage} visibleCount={rows.length}/>
  </div>;
}
