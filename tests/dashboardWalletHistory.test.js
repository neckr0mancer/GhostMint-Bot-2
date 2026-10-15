const assert=require('node:assert/strict');
const test=require('node:test');

const displayPromise=import('../dashboard/src/walletHistoryDisplay.mjs');

test('wallet history provenance labels fail closed',async()=>{
  const {walletHistorySourceMeta}=await displayPromise;
  assert.deepEqual(walletHistorySourceMeta('ghostmint'),{label:'GhostMint',tone:'ac'});
  assert.deepEqual(walletHistorySourceMeta('external'),{label:'External',tone:'nu'});
  assert.equal(walletHistorySourceMeta('source_unknown').label,'Source unknown');
  assert.equal(walletHistorySourceMeta('unexpected').label,'Source unknown');
  assert.equal(walletHistorySourceMeta(null).label,'Source unknown');
});

test('wallet history status never calls an unfinalized success confirmed',async()=>{
  const {walletHistoryStatusMeta}=await displayPromise;
  assert.deepEqual(walletHistoryStatusMeta({executionStatus:'success',finalityStatus:'finalized'}),
    {label:'Confirmed',tone:'ok'});
  assert.deepEqual(walletHistoryStatusMeta({executionStatus:'success',finalityStatus:'unfinalized'}),
    {label:'Awaiting finality',tone:'info'});
  assert.equal(walletHistoryStatusMeta({executionStatus:'reverted'}).label,'Reverted');
  assert.equal(walletHistoryStatusMeta({executionStatus:'unknown'}).label,'Status unknown');
});

test('wallet history coverage states make honest completeness and polling claims',async()=>{
  const {walletHistoryCoverageMeta}=await displayPromise;
  assert.equal(walletHistoryCoverageMeta({state:'not_started'}).title,'History has not been loaded');
  assert.equal(walletHistoryCoverageMeta({state:'queued'}).polling,true);
  assert.equal(walletHistoryCoverageMeta({state:'backfilling'}).polling,true);
  assert.equal(walletHistoryCoverageMeta({state:'current'}).title,'Wallet history is up to date');
  assert.equal(walletHistoryCoverageMeta({state:'partial'}).tone,'w');
  assert.equal(walletHistoryCoverageMeta({state:'unsupported'}).tone,'n');
  assert.equal(walletHistoryCoverageMeta({state:'error'}).tone,'e');
  assert.equal(walletHistoryCoverageMeta({state:'mixed',chains:[{state:'current'},{state:'queued'}]}).polling,true);
  assert.equal(walletHistoryCoverageMeta({state:'mixed',chains:[{state:'current'},{state:'partial'}]}).polling,false);
  assert.equal(walletHistoryCoverageMeta({state:'invented'}).title,'History status unavailable');
});

test('raw blockchain units are formatted without Number precision loss',async()=>{
  const {formatRawUnits}=await displayPromise;
  assert.equal(formatRawUnits('1',18),'0.000000000000000001');
  assert.equal(formatRawUnits('1000000000000000000',18),'1');
  assert.equal(formatRawUnits('1234500',6),'1.2345');
  assert.equal(formatRawUnits('0',18),'0');
  assert.equal(formatRawUnits('900719925474099312345678',0),'900719925474099312345678');
  assert.throws(()=>formatRawUnits('-1',18),/unsigned/);
  assert.throws(()=>formatRawUnits('1e18',18),/unsigned/);
  assert.throws(()=>formatRawUnits('1.2',18),/unsigned/);
  assert.throws(()=>formatRawUnits('1',1.5),/decimals/);
});

test('transaction summaries choose one truthful primary movement',async()=>{
  const {walletHistoryTransactionSummary}=await displayPromise;
  const mint=walletHistoryTransactionSummary({executionStatus:'success',movements:[
    {eventType:'native_transfer',assetStandard:'native',direction:'out',amountRaw:'1000000000000000'},
    {eventType:'mint',assetStandard:'erc721',direction:'in',amountRaw:'1',tokenId:'42',
      details:{contractName:'Night Garden'},fromAddress:'0x0000000000000000000000000000000000000000'},
  ]},{nativeSymbol:'ETH'});
  assert.equal(mint.title,'Minted Night Garden');
  assert.equal(mint.amountLabel,'Token #42');
  assert.equal(mint.extraMovementCount,1);

  const token=walletHistoryTransactionSummary({executionStatus:'success',movements:[{
    eventType:'erc20_transfer',assetStandard:'erc20',direction:'in',amountRaw:'900719925474099312345678',
    fromAddress:'0x1111111111111111111111111111111111111111',details:{symbol:'TOK'},
  }]});
  assert.equal(token.title,'Received TOK');
  assert.equal(token.amountLabel,'900719925474099312345678 raw units · TOK');
  assert.equal(token.counterparty,'0x1111…1111');

  const reverted=walletHistoryTransactionSummary({executionStatus:'reverted',movements:[{
    eventType:'mint',assetStandard:'erc721',direction:'in',details:{contractName:'Never Minted'},
  }]});
  assert.equal(reverted.title,'Transaction reverted');
  assert.equal(reverted.title.includes('Minted'),false);
  assert.equal(walletHistoryTransactionSummary({executionStatus:'unknown'}).title,'Transaction status unknown');
});

test('wallet history search distinguishes full addresses from hash prefixes',async()=>{
  const {parseWalletHistorySearch}=await displayPromise;
  assert.deepEqual(parseWalletHistorySearch(''),{valid:true,value:'',kind:null,address:null,txHash:null});
  const address=`0x${'AB'.repeat(20)}`;
  assert.equal(parseWalletHistorySearch(`  ${address}  `).kind,'address');
  assert.equal(parseWalletHistorySearch(address).address,address.toLowerCase());
  assert.equal(parseWalletHistorySearch('0xabc123').kind,'txHash');
  assert.equal(parseWalletHistorySearch(`0x${'ab'.repeat(32)}`).kind,'txHash');
  assert.equal(parseWalletHistorySearch('abc123').valid,false);
  assert.equal(parseWalletHistorySearch('0xzz').valid,false);
});

test('wallet history path is deterministic, validated, and snapshot aware',async()=>{
  const {buildAccountWalletHistoryPath,buildWalletHistoryPath,parseWalletHistorySearch}=await displayPromise;
  assert.equal(buildWalletHistoryPath(41,{page:2,pageSize:10,chain:'Ethereum',source:'external',
    status:'success',direction:'in',type:'erc721',search:parseWalletHistorySearch('0xabc'),
    snapshotAt:'2026-01-01T00:00:00.000Z'}),
  '/api/wallets/41/history?page=2&pageSize=10&chain=ethereum&source=external&status=success&direction=in&type=erc721&txHash=0xabc&snapshotAt=2026-01-01T00%3A00%3A00.000Z');
  assert.equal(buildWalletHistoryPath(41,{page:1,pageSize:20,source:'all',status:'all',
    direction:'all',type:'all'}),'/api/wallets/41/history?page=1&pageSize=20');
  assert.throws(()=>buildWalletHistoryPath('',{}),/walletId/);
  assert.throws(()=>buildWalletHistoryPath(41,{page:0}),/page/);
  assert.throws(()=>buildWalletHistoryPath(41,{source:'trusted'}),/source/);
  assert.throws(()=>buildWalletHistoryPath(41,{snapshotAt:'yesterday'}),/snapshot/);

  assert.equal(buildAccountWalletHistoryPath({page:3,pageSize:25,walletId:41,chain:'Base',
    source:'ghostmint',status:'reverted',type:'erc721',search:parseWalletHistorySearch('0xdef')}),
  '/api/history/transactions?page=3&pageSize=25&walletId=41&chain=base&source=ghostmint&status=reverted&type=erc721&txHash=0xdef');
  assert.equal(buildAccountWalletHistoryPath({}),
    '/api/history/transactions?page=1&pageSize=20');
  assert.throws(()=>buildAccountWalletHistoryPath({walletId:0}),/walletId/);
});
