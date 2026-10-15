const ADDRESS=/^0x[0-9a-f]{40}$/;
const HASH_PREFIX=/^0x[0-9a-f]{1,64}$/;
const UNSIGNED=/^(0|[1-9][0-9]*)$/;
const SOURCES=new Set(['ghostmint','external','source_unknown']);
const STATUSES=new Set(['success','reverted','unknown']);
const DIRECTIONS=new Set(['in','out','self','unknown']);

function cleanText(value,maximum=80){
  const text=typeof value==='string'?value.trim():'';
  return text&&!/[\u0000-\u001f\u007f]/.test(text)?text.slice(0,maximum):'';
}

function shortAddress(value){
  const address=String(value||'').toLowerCase();
  return ADDRESS.test(address)?`${address.slice(0,6)}…${address.slice(-4)}`:'';
}

export function walletHistorySourceMeta(source){
  if(source==='ghostmint')return {label:'GhostMint',tone:'ac'};
  if(source==='external')return {label:'External',tone:'nu'};
  return {label:'Source unknown',tone:'nu'};
}

export function walletHistoryStatusMeta(transaction={}){
  if(transaction.executionStatus==='reverted')return {label:'Reverted',tone:'bad'};
  if(transaction.executionStatus==='success'&&transaction.finalityStatus==='finalized'){
    return {label:'Confirmed',tone:'ok'};
  }
  if(transaction.executionStatus==='success')return {label:'Awaiting finality',tone:'info'};
  return {label:'Status unknown',tone:'nu'};
}

export function walletHistoryCoverageMeta(coverage={}){
  const state=cleanText(coverage?.state,32).toLowerCase()||'not_started';
  const childStates=Array.isArray(coverage?.chains)
    ?coverage.chains.map(item=>String(item?.state||'').toLowerCase()):[];
  const polling=state==='queued'||state==='backfilling'
    ||(state==='mixed'&&childStates.some(item=>item==='queued'||item==='backfilling'));
  const values={
    not_started:{title:'History has not been loaded',detail:'Refresh to look for public on-chain activity. Until then, this list makes no completeness claim.',tone:'i'},
    queued:{title:'History update queued',detail:'GhostMint is waiting to start. Any existing transactions remain available while it waits.',tone:'i'},
    backfilling:{title:'Loading wallet history',detail:'Earlier transactions are still being added. Results shown now may be incomplete.',tone:'i'},
    current:{title:'Wallet history is up to date',detail:'Tracked network history is current as of the latest completed refresh.',tone:'ok'},
    partial:{title:'Wallet history is incomplete',detail:'Some activity is available, but this is not a complete history yet.',tone:'w'},
    unsupported:{title:'History is unavailable for this network',detail:'This server does not have a history provider for the selected network.',tone:'n'},
    error:{title:'History could not refresh',detail:'The wallet and its funds are unaffected. You can try the refresh again.',tone:'e'},
    mixed:{title:'Coverage varies by network',detail:'Some network histories are still loading, incomplete, or unavailable.',tone:'w'},
  };
  return {...(values[state]||{title:'History status unavailable',detail:'No completeness claim can be made for this wallet history.',tone:'n'}),state,polling};
}

export function formatRawUnits(raw,decimals){
  const value=String(raw??'');
  if(!UNSIGNED.test(value))throw new TypeError('raw amount must be an unsigned decimal string');
  if(!Number.isSafeInteger(decimals)||decimals<0||decimals>255){
    throw new TypeError('decimals must be a safe integer between 0 and 255');
  }
  if(decimals===0)return value;
  const padded=value.padStart(decimals+1,'0');
  const integer=padded.slice(0,-decimals);
  const fraction=padded.slice(-decimals).replace(/0+$/,'');
  return fraction?`${integer}.${fraction}`:integer;
}

function movementRank(movement){
  const type=movement?.eventType;
  if(type==='mint')return 0;
  if(type==='burn')return 1;
  if(movement?.assetStandard==='erc721'||movement?.assetStandard==='erc1155')return 2;
  if(movement?.assetStandard==='erc20')return 3;
  if(type==='native_transfer'||movement?.assetStandard==='native')return 4;
  if(type==='approval')return 5;
  return 6;
}

function assetLabel(movement,nativeSymbol){
  const details=movement?.details&&typeof movement.details==='object'?movement.details:{};
  const named=cleanText(details.contractName)||cleanText(details.symbol,24);
  if(named)return named;
  const address=shortAddress(movement?.assetAddress);
  if(address)return address;
  if(movement?.assetStandard==='native')return nativeSymbol;
  if(movement?.assetStandard==='erc721'||movement?.assetStandard==='erc1155')return 'NFT';
  if(movement?.assetStandard==='erc20')return 'tokens';
  return '';
}

function amountLabel(movement,nativeSymbol){
  const raw=movement?.amountRaw;
  if(raw===null||raw===undefined||raw==='')return '';
  const details=movement?.details&&typeof movement.details==='object'?movement.details:{};
  const standard=movement?.assetStandard;
  if(standard==='erc721')return movement.tokenId!==null&&movement.tokenId!==undefined
    ?`Token #${movement.tokenId}`:'1 NFT';
  if(standard==='erc1155')return `${formatRawUnits(raw,0)} NFT${String(raw)==='1'?'':'s'}`;
  if(standard==='native')return `${formatRawUnits(raw,18)} ${nativeSymbol}`;
  if(standard==='erc20'){
    const decimals=details.decimals;
    const symbol=cleanText(details.symbol,24);
    if(Number.isSafeInteger(decimals)&&decimals>=0&&decimals<=255){
      return `${formatRawUnits(raw,decimals)}${symbol?` ${symbol}`:''}`;
    }
    return `${formatRawUnits(raw,0)} raw units${symbol?` · ${symbol}`:''}`;
  }
  return formatRawUnits(raw,0);
}

function directionVerb(direction,{received='Received',sent='Sent',moved='Moved'}={}){
  if(direction==='in')return received;
  if(direction==='out')return sent;
  return moved;
}

export function walletHistoryTransactionSummary(transaction={},options={}){
  const nativeSymbol=cleanText(options.nativeSymbol,16)||'native token';
  if(transaction.executionStatus==='reverted'){
    return {title:'Transaction reverted',amountLabel:'',assetLabel:'',counterparty:'',extraMovementCount:0};
  }
  if(transaction.executionStatus!=='success'){
    return {title:'Transaction status unknown',amountLabel:'',assetLabel:'',counterparty:'',extraMovementCount:0};
  }
  const movements=(Array.isArray(transaction.movements)?transaction.movements:[])
    .filter(item=>item&&item.eventType!=='fee');
  const ordered=movements.map((movement,index)=>({movement,index}))
    .sort((left,right)=>movementRank(left.movement)-movementRank(right.movement)||left.index-right.index);
  const primary=ordered[0]?.movement||null;
  if(!primary)return {title:'Contract interaction',amountLabel:'',assetLabel:'',counterparty:'',extraMovementCount:0};
  const asset=assetLabel(primary,nativeSymbol);
  const standard=primary.assetStandard;
  const transferAsset=standard==='erc721'||standard==='erc1155'?'NFT'
    :standard==='native'?nativeSymbol:(asset||'tokens');
  let title='Contract interaction';
  if(primary.eventType==='mint')title=`Minted ${asset||'NFT'}`;
  else if(primary.eventType==='burn')title=`Burned ${asset||'NFT'}`;
  else if(primary.eventType==='approval')title='Approved contract';
  else if(['erc721_transfer','erc1155_transfer','erc20_transfer','native_transfer'].includes(primary.eventType)
    ||['erc721','erc1155','erc20','native'].includes(standard)){
    title=`${directionVerb(primary.direction)} ${transferAsset}`;
  }
  const counterpartyRaw=primary.direction==='in'?primary.fromAddress
    :primary.direction==='out'?primary.toAddress:null;
  const zero='0x0000000000000000000000000000000000000000';
  const counterparty=String(counterpartyRaw||'').toLowerCase()===zero?'':shortAddress(counterpartyRaw);
  return {title,amountLabel:amountLabel(primary,nativeSymbol),assetLabel:asset,counterparty,
    extraMovementCount:Math.max(0,movements.length-1)};
}

export function parseWalletHistorySearch(input){
  const value=String(input??'').trim().toLowerCase();
  if(!value)return {valid:true,value:'',kind:null,address:null,txHash:null};
  if(ADDRESS.test(value))return {valid:true,value,kind:'address',address:value,txHash:null};
  if(HASH_PREFIX.test(value))return {valid:true,value,kind:'txHash',address:null,txHash:value};
  return {valid:false,value,kind:null,address:null,txHash:null,
    error:'Enter a full EVM address or a transaction hash beginning with 0x.'};
}

function integer(value,fallback,maximum,field){
  const parsed=value===undefined||value===null||value===''?fallback:Number(value);
  if(!Number.isInteger(parsed)||parsed<1||parsed>maximum)throw new TypeError(`${field} is invalid`);
  return parsed;
}

export function buildWalletHistoryPath(walletId,options={}){
  const id=integer(walletId,null,Number.MAX_SAFE_INTEGER,'walletId');
  const page=integer(options.page,1,1_000_000,'page');
  const pageSize=integer(options.pageSize,20,100,'pageSize');
  const params=new URLSearchParams([['page',String(page)],['pageSize',String(pageSize)]]);
  const chain=cleanText(options.chain,64).toLowerCase();
  if(chain)params.set('chain',chain);
  if(options.source&&options.source!=='all'){
    if(!SOURCES.has(options.source))throw new TypeError('source is invalid');
    params.set('source',options.source);
  }
  if(options.status&&options.status!=='all'){
    if(!STATUSES.has(options.status))throw new TypeError('status is invalid');
    params.set('status',options.status);
  }
  if(options.direction&&options.direction!=='all'){
    if(!DIRECTIONS.has(options.direction))throw new TypeError('direction is invalid');
    params.set('direction',options.direction);
  }
  const type=cleanText(options.type,32).toLowerCase();
  if(type&&type!=='all')params.set('type',type);
  const search=options.search&&typeof options.search==='object'
    ?options.search:parseWalletHistorySearch(options.searchText);
  if(search?.valid===false)throw new TypeError(search.error);
  if(search?.txHash){if(!HASH_PREFIX.test(search.txHash))throw new TypeError('txHash is invalid');params.set('txHash',search.txHash);}
  if(search?.address){if(!ADDRESS.test(search.address))throw new TypeError('address is invalid');params.set('address',search.address);}
  if(options.snapshotAt){
    const snapshot=new Date(options.snapshotAt);
    if(!Number.isFinite(snapshot.getTime()))throw new TypeError('snapshotAt is invalid');
    params.set('snapshotAt',snapshot.toISOString());
  }
  return `/api/wallets/${encodeURIComponent(id)}/history?${params.toString()}`;
}

export function buildAccountWalletHistoryPath(options={}){
  const page=integer(options.page,1,1_000_000,'page');
  const pageSize=integer(options.pageSize,20,100,'pageSize');
  const params=new URLSearchParams([['page',String(page)],['pageSize',String(pageSize)]]);
  if(options.walletId!==undefined&&options.walletId!==null&&options.walletId!==''){
    params.set('walletId',String(integer(options.walletId,null,Number.MAX_SAFE_INTEGER,'walletId')));
  }
  const chain=cleanText(options.chain,64).toLowerCase();
  if(chain)params.set('chain',chain);
  if(options.source&&options.source!=='all'){
    if(!SOURCES.has(options.source))throw new TypeError('source is invalid');
    params.set('source',options.source);
  }
  if(options.status&&options.status!=='all'){
    if(!STATUSES.has(options.status))throw new TypeError('status is invalid');
    params.set('status',options.status);
  }
  if(options.direction&&options.direction!=='all'){
    if(!DIRECTIONS.has(options.direction))throw new TypeError('direction is invalid');
    params.set('direction',options.direction);
  }
  const type=cleanText(options.type,32).toLowerCase();
  if(type&&type!=='all')params.set('type',type);
  const search=options.search&&typeof options.search==='object'
    ?options.search:parseWalletHistorySearch(options.searchText);
  if(search?.valid===false)throw new TypeError(search.error);
  if(search?.txHash){if(!HASH_PREFIX.test(search.txHash))throw new TypeError('txHash is invalid');params.set('txHash',search.txHash);}
  if(search?.address){if(!ADDRESS.test(search.address))throw new TypeError('address is invalid');params.set('address',search.address);}
  if(options.snapshotAt){
    const snapshot=new Date(options.snapshotAt);
    if(!Number.isFinite(snapshot.getTime()))throw new TypeError('snapshotAt is invalid');
    params.set('snapshotAt',snapshot.toISOString());
  }
  return `/api/history/transactions?${params.toString()}`;
}
