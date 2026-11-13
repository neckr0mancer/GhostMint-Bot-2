const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWalletHistoryRepository, mapAccountTransaction } = require('../src/walletHistory/repository');

const USER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0x00000000000000000000000000000000000000a7';

test('migration and repository define recoverable ownership-guarded leases', () => {
  const migration = fs.readFileSync(path.join(__dirname,'..','migrations',
    '073_wallet_history_foundation.sql'),'utf8');
  assert.match(migration,/claimed_by TEXT/);
  assert.match(migration,/claimed_at TIMESTAMPTZ/);
  assert.match(migration,/lease_expires_at TIMESTAMPTZ/);
  assert.match(migration,/state IN \('queued','backfilling','error'\)/);
  const source = fs.readFileSync(path.join(__dirname,'..','src','walletHistory','repository.js'),'utf8');
  assert.match(source,/FOR UPDATE OF sync SKIP LOCKED LIMIT 1/);
  assert.match(source,/SELECT sync_enabled FROM wallet_history_subjects/);
  assert.match(source,/Wallet history sync is stale because the wallet was removed/);
  assert.match(source,/WITH owned_wallet AS/);
  assert.match(source,/WHERE user_id=\$1 AND LOWER\(address\)=\$3 LIMIT 1 FOR KEY SHARE/);
  assert.match(source,/WITH active_subject AS/);
  assert.match(source,/sync\.state='error' AND sync\.retry_after IS NOT NULL/);
  assert.match(source,/claimed_by=\$7 AND lease_expires_at>NOW\(\)/);
  assert.match(source,/claimed_by=\$10 AND lease_expires_at>NOW\(\)/);
  assert.match(source,/wallet_history_transactions\.finality_status<>'finalized'/);
  assert.match(source,/block_number=ANY\(\$4::BIGINT\[\]\) AND canonical=TRUE/);
  assert.match(source,/incomingCanonicalByBlock/);
  assert.match(source,/finality_status='finalized' LIMIT 1/);
  assert.match(source,/AND finality_status<>'finalized'/);
  assert.match(source,/Per-page RPC finality proves the labels on that page only/);
  assert.equal((source.match(/tx\.finality_status='finalized'/g) || []).length,2);
  assert.equal((source.match(/sync\.state='current'/g) || []).length,2);
  assert.equal((source.match(/tx\.provider_complete=TRUE/g) || []).length,2);
});

test('claimDue maps one lease and starts a queued generation atomically', async () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const calls = [];
  const pool = { query:async (sql,params) => {
    calls.push({sql,params});
    return {rowCount:1,rows:[{
      user_id:USER,chain:'ethereum',wallet_address:ADDRESS,provider_key:'goldrush',
      state:'backfilling',cursor:null,generation:'4',attempts:2,
      claimed_by:'worker-a',claimed_at:new Date(now),
      lease_expires_at:new Date(now+30_000),
    }]};
  } };
  const claim = await createWalletHistoryRepository(pool).claimDue({
    workerId:'Worker-A',now,leaseMs:30_000,
  });
  assert.equal(claim.userId,USER);
  assert.equal(claim.claimedBy,'worker-a');
  assert.equal(claim.generation,4);
  assert.deepEqual(calls[0].params,['worker-a',now,30_000]);
  assert.match(calls[0].sql,/CASE WHEN sync\.state='queued' THEN sync\.generation\+1/);
  assert.match(calls[0].sql,/claimed_by IS NULL OR sync\.lease_expires_at<=/);
});

test('releaseClaim is scoped to the exact account, chain, address, and owner', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rowCount:0,rows:[]};
  }};
  const released=await createWalletHistoryRepository(pool).releaseClaim({
    userId:USER,chain:'ethereum',walletAddress:ADDRESS,workerId:'worker-a',
  });
  assert.equal(released,null);
  assert.deepEqual(calls[0].params,[USER,'ethereum',ADDRESS,'worker-a']);
  assert.match(calls[0].sql,/wallet_address=\$3 AND claimed_by=\$4/);
});

test('queueSync preserves an active backfill cursor and lease instead of resetting its worker', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rowCount:1,rows:[{
      user_id:USER,chain:'ethereum',wallet_address:ADDRESS,provider_key:'goldrush',
      state:'backfilling',cursor:{page:2},generation:'4',attempts:2,
      claimed_by:'worker-a',claimed_at:new Date('2026-10-13T12:00:00Z'),
      lease_expires_at:new Date('2026-10-13T12:01:00Z'),
    }]};
  }};
  const queued=await createWalletHistoryRepository(pool).queueSync({
    userId:USER,chain:'ethereum',walletAddress:ADDRESS,providerKey:'goldrush',
  });
  assert.equal(queued.state,'backfilling');
  assert.equal(queued.claimedBy,'worker-a');
  assert.deepEqual(queued.cursor,{page:2});
  assert.deepEqual(calls[0].params,[USER,'ethereum',ADDRESS,'goldrush']);
  assert.match(calls[0].sql,/state IN \('queued','backfilling'\)/);
  assert.match(calls[0].sql,/claimed_by IS NOT NULL\s+AND wallet_history_sync_state\.lease_expires_at>NOW\(\)/);
  assert.match(calls[0].sql,/THEN wallet_history_sync_state\.claimed_by ELSE NULL/);
});

test('queueSync preserves a retry worker that owns a live error lease', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rowCount:1,rows:[{
      user_id:USER,chain:'ethereum',wallet_address:ADDRESS,provider_key:'goldrush',
      state:'error',cursor:{page:3},generation:'7',attempts:4,
      last_error_code:'RATE_LIMITED',last_error_message:'retrying provider request',
      retry_after:new Date('2026-10-13T11:59:00Z'),claimed_by:'worker-retry',
      claimed_at:new Date('2026-10-13T12:00:00Z'),
      lease_expires_at:new Date('2026-10-13T12:01:00Z'),
    }]};
  }};
  const queued=await createWalletHistoryRepository(pool).queueSync({
    userId:USER,chain:'ethereum',walletAddress:ADDRESS,providerKey:'goldrush',
  });
  assert.equal(queued.state,'error');
  assert.equal(queued.generation,7);
  assert.equal(queued.claimedBy,'worker-retry');
  assert.deepEqual(queued.cursor,{page:3});
  assert.equal(queued.lastErrorCode,'RATE_LIMITED');
  assert.match(calls[0].sql,/state IN \('queued','backfilling'\)\s+OR \(wallet_history_sync_state\.claimed_by IS NOT NULL/);
  assert.match(calls[0].sql,/claimed_by=CASE WHEN wallet_history_sync_state\.claimed_by IS NOT NULL/);
});

test('account ledger is tenant scoped, deduplicates an address, classifies provenance, and reports every wallet-chain coverage pair', async () => {
  const calls=[];
  const txHash=`0x${'ab'.repeat(32)}`;
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    if(/CROSS JOIN requested_chains/.test(sql))return {rowCount:4,rows:[
      {wallet_id:'7',wallet_label:'Trading',wallet_address:ADDRESS,chain:'base',state:'not_started'},
      {wallet_id:'7',wallet_label:'Trading',wallet_address:ADDRESS,chain:'ethereum',state:'current',
        history_complete_from_block:'0',history_complete_through_block:'200',
        provenance_complete_from_block:'100',provenance_complete_through_block:'200',
        finalized_through_block:'190'},
      {wallet_id:'8',wallet_label:'Vault',wallet_address:'0x00000000000000000000000000000000000000b8',
        chain:'base',state:'not_started'},
      {wallet_id:'8',wallet_label:'Vault',wallet_address:'0x00000000000000000000000000000000000000b8',
        chain:'ethereum',state:'not_started'},
    ]};
    return {rowCount:1,rows:[{
      wallet_id:'7',wallet_label:'Trading',chain:'ethereum',wallet_address:ADDRESS,
      tx_hash:txHash,block_number:'101',block_hash:null,transaction_index:0,
      occurred_at:new Date('2026-10-13T12:00:00Z'),from_address:ADDRESS,to_address:null,
      nonce:'1',input:'0x',method_selector:null,value_wei:'1',gas_limit:'21000',
      gas_used:'21000',effective_gas_price_wei:'2',network_fee_wei:'42000',
      execution_status:'success',finality_status:'finalized',canonical:true,source:'ghostmint',
      provider_key:'fixture',provider_complete:true,
      first_observed_at:new Date('2026-10-13T12:00:01Z'),
      last_observed_at:new Date('2026-10-13T12:00:02Z'),movements:[],result_total:'1',
    }]};
  }};
  const page=await createWalletHistoryRepository(pool).listAccountPage(USER,{
    supportedChains:['ethereum','base'],limit:20,offset:0,
    snapshotAt:'2026-10-13T13:00:00Z',source:'ghostmint',
  });
  assert.equal(page.total,1);
  assert.equal(page.items[0].walletId,7);
  assert.equal(page.items[0].walletLabel,'Trading');
  assert.equal(page.items[0].walletAddress,ADDRESS);
  assert.equal(page.items[0].source,'ghostmint');
  assert.equal(page.coverage.state,'mixed');
  assert.equal(page.coverage.chains.length,4);
  assert.deepEqual(page.coverage.chains[0],{
    walletId:7,walletLabel:'Trading',walletAddress:ADDRESS,chain:'base',state:'not_started',
    historyFromBlock:null,historyThroughBlock:null,provenanceFromBlock:null,
    provenanceThroughBlock:null,finalizedThroughBlock:null,
  });
  assert.equal(page.coverage.chains[1].historyThroughBlock,'200');
  assert.match(calls[0].sql,/FROM wallets\s+WHERE user_id=\$1 AND \(\$2::BIGINT IS NULL OR id=\$2\)/);
  for(const call of calls) {
    assert.match(call.sql,/SELECT DISTINCT ON \(LOWER\(address\)\) id,label,LOWER\(address\) AS wallet_address/);
    assert.match(call.sql,/ORDER BY LOWER\(address\),id/);
  }
  assert.match(calls[0].sql,/JOIN owned_wallets wallet ON wallet\.wallet_address=tx\.wallet_address/);
  assert.match(calls[0].sql,/JOIN wallet_history_subjects subject\s+ON subject\.user_id=tx\.user_id AND subject\.chain=tx\.chain\s+AND subject\.wallet_address=tx\.wallet_address/);
  assert.doesNotMatch(calls[0].sql,/JOIN wallet_history_subjects subject USING/);
  assert.match(calls[0].sql,/EXISTS \(\s*SELECT 1 FROM transaction_intents intent/);
  assert.match(calls[0].sql,/sync\.state='current'/);
  assert.match(calls[0].sql,/tx\.provider_complete=TRUE/);
  assert.match(calls[0].sql,/tx\.finality_status='finalized'/);
  assert.match(calls[0].sql,/ELSE 'source_unknown' END AS source/);
  assert.deepEqual(calls[1].params,[USER,null,['base','ethereum']]);
  assert.match(calls[1].sql,/COALESCE\(sync\.state,'not_started'\) AS state/);
  assert.throws(()=>mapAccountTransaction({wallet_id:'9007199254740992',movements:[]}),
    /walletId exceeds the safe API range/);
});
