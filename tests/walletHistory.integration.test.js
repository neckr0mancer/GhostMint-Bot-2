const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { createWalletHistoryRepository } = require('../src/walletHistory/repository');
const { createTestDatabasePool, integrationTest, runTestMigrations } = require('./helpers/disposableDatabase');

const address = '0x00000000000000000000000000000000000000a7';
const target = '0x00000000000000000000000000000000000000b8';
const runHashSuffix = randomBytes(4).toString('hex');
const hash = digit => `0x${digit.repeat(56)}${runHashSuffix}`;

function importedTransaction(txHash, blockNumber, occurredAt, {
  finalized = true,
  canonical = true,
  blockHash = hash('f'),
  movements,
} = {}) {
  return {
    txHash,
    blockNumber:String(blockNumber),
    blockHash,
    transactionIndex:'0',
    occurredAt,
    fromAddress:address,
    toAddress:target,
    nonce:String(blockNumber),
    input:'0x',
    methodSelector:null,
    valueWei:'0',
    gasLimit:'21000',
    gasUsed:'21000',
    effectiveGasPriceWei:'1',
    networkFeeWei:'21000',
    executionStatus:'success',
    finalityStatus:finalized ? 'finalized' : 'unfinalized',
    canonical,
    rawSummary:null,
    movements:movements || [{
      eventLocator:'native:value',eventType:'native_transfer',direction:'out',assetStandard:'native',
      assetAddress:null,tokenId:null,amountRaw:'0',fromAddress:address,toAddress:target,details:null,
    }],
  };
}

integrationTest('wallet history migration stores pages and derives provenance from durable GhostMint evidence',
  { timeout: 240_000 }, async () => {
    await runTestMigrations({ migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
    const pool = await createTestDatabasePool({ max: 2 });
    const repository = createWalletHistoryRepository(pool);
    const storage = createPostgresStorage(pool);
    const userId = randomUUID();
    const cleanupUserIds = [userId];
    try {
      await pool.query('INSERT INTO users(user_id) VALUES ($1)', [userId]);
      const wallet = await pool.query(`INSERT INTO wallets
        (user_id,label,address,chain,encrypted_private_key,encryption_salt,encryption_nonce,
          encryption_auth_tag,encryption_key_version)
        VALUES ($1,'history-wallet',$2,'ethereum','ciphertext','salt','nonce','tag',1)
        RETURNING id`, [userId, address]);
      const ghostMintHash = hash('a');
      const externalHash = hash('b');
      const unknownHash = hash('c');
      const intent = await pool.query(`INSERT INTO transaction_intents
        (user_id,wallet_id,chain,from_address,to_address,calldata,value_wei,nonce,gas_limit,
          estimated_cost_wei,simulation_enabled,required_confirmations,transaction_timeout_ms,
          state,tx_hash,timeout_at)
        VALUES ($1,$2,'ethereum',$3,$4,'0x',0,1,21000,21000,TRUE,1,60000,'confirmed',$5,NOW()+INTERVAL '1 hour')
        RETURNING intent_id`, [userId, wallet.rows[0].id, address, target, ghostMintHash]);
      await pool.query(`INSERT INTO transaction_broadcast_hashes(intent_id,tx_hash)
        VALUES ($1,$2)`, [intent.rows[0].intent_id, hash('d')]);

      await repository.registerSubject({ userId, chain:'ethereum', walletAddress:address,
        trackingStartBlock:'100' });
      const sync = await repository.beginSync({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture' });
      const occurredAt = new Date().toISOString();
      const state = await repository.applyProviderPage({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:sync.generation, page:{
          supported:true,chain:'ethereum',providerKey:'fixture',
          transactions:[
            importedTransaction(ghostMintHash,101,occurredAt),
            importedTransaction(externalHash,102,occurredAt),
            importedTransaction(unknownHash,99,occurredAt),
          ],
          nextCursor:null,hasMore:false,observedHeadBlock:'102',
          finalizedThroughBlock:'102',
          coverage:{
            history:{fromBlock:'0',throughBlock:'102',complete:true},
            provenance:{fromBlock:'101',throughBlock:'102',complete:true},
          },
          recheckRange:{fromBlock:'0',throughBlock:'102'},
        } });
      assert.equal(state.state, 'current');
      assert.equal(state.finalizedThroughBlock, null);

      const all = await repository.listPage(userId, { chain:'ethereum', walletAddress:address,
        limit:20, offset:0 });
      assert.equal(all.total, 3);
      assert.deepEqual(Object.fromEntries(all.items.map(item => [item.txHash, item.source])), {
        [ghostMintHash]:'ghostmint',
        [externalHash]:'external',
        [unknownHash]:'source_unknown',
      });
      assert.equal(all.items[0].movements[0].eventType, 'native_transfer');
      assert.equal(all.coverage.state, 'current');

      await repository.registerSubject({ userId, chain:'base', walletAddress:address,
        trackingStartBlock:'100' });
      const baseSync = await repository.beginSync({ userId, chain:'base', walletAddress:address,
        providerKey:'fixture' });
      await repository.applyProviderPage({ userId, chain:'base', walletAddress:address,
        providerKey:'fixture', generation:baseSync.generation, expectedCursor:null, page:{
          supported:true,chain:'base',providerKey:'fixture',
          transactions:[importedTransaction(hash('e'),100,occurredAt)],
          nextCursor:{page:1},hasMore:true,observedHeadBlock:'101',finalizedThroughBlock:'101',coverage:{
            history:null,provenance:null,
          },recheckRange:null,
        } });
      await repository.applyProviderPage({ userId, chain:'base', walletAddress:address,
        providerKey:'fixture', generation:baseSync.generation, expectedCursor:{page:1}, page:{
          supported:true,chain:'base',providerKey:'fixture',
          transactions:[importedTransaction(hash('6'),101,occurredAt)],
          nextCursor:null,hasMore:false,observedHeadBlock:'101',finalizedThroughBlock:'101',coverage:{
            history:{fromBlock:'0',throughBlock:'101',complete:true},
            provenance:{fromBlock:'101',throughBlock:'101',complete:true},
          },recheckRange:{fromBlock:'0',throughBlock:'101'},
        } });
      const completedGeneration = await pool.query(`SELECT tx_hash,provider_complete
        FROM wallet_history_transactions
        WHERE user_id=$1 AND chain='base' AND wallet_address=$2 ORDER BY tx_hash`, [userId,address]);
      assert.equal(completedGeneration.rowCount, 2);
      assert.equal(completedGeneration.rows.every(row => row.provider_complete === true), true);
      const everyChain = await repository.listPage(userId, { walletAddress:address,
        limit:20, offset:0 });
      assert.equal(everyChain.total, 5);
      assert.deepEqual(everyChain.coverage.chains.map(item => item.chain), ['base', 'ethereum']);

      const accountPage = await repository.listAccountPage(userId, {
        supportedChains:['ethereum','base','ink'],limit:20,offset:0,
        snapshotAt:everyChain.snapshotAt,
      });
      assert.equal(accountPage.total,5);
      assert.equal(accountPage.items.every(item => item.walletId===Number(wallet.rows[0].id)),true);
      assert.equal(accountPage.items.every(item => item.walletLabel==='history-wallet'),true);
      assert.equal(accountPage.items.every(item => item.walletAddress===address),true);
      assert.deepEqual(accountPage.coverage.chains.map(item=>[item.walletLabel,item.chain,item.state]),[
        ['history-wallet','base','current'],
        ['history-wallet','ethereum','current'],
        ['history-wallet','ink','not_started'],
      ]);
      const ethereumAccountPage=await repository.listAccountPage(userId,{
        walletId:wallet.rows[0].id,chain:'ethereum',supportedChains:['ethereum','base','ink'],
        source:'ghostmint',limit:20,offset:0,snapshotAt:accountPage.snapshotAt,
      });
      assert.deepEqual(ethereumAccountPage.items.map(item=>item.txHash),[ghostMintHash]);
      assert.deepEqual(ethereumAccountPage.coverage.chains.map(item=>item.chain),['ethereum']);

      await repository.registerSubject({ userId,chain:'ink',walletAddress:address,
        trackingStartBlock:'200' });
      await repository.setSyncState({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',state:'queued' });
      const leaseNow = Date.now();
      // The disposable Railway database crosses a public proxy, so a one-second lease can expire
      // between the claim and the following queue request even when the implementation is correct.
      // Use a realistic worker lease while keeping the recovery boundary deterministic below.
      const activeLeaseMs = 30_000;
      const firstClaim = await repository.claimDue({
        workerId:'worker-a',now:leaseNow,leaseMs:activeLeaseMs,
      });
      assert.equal(firstClaim.chain, 'ink');
      assert.equal(firstClaim.state, 'backfilling');
      assert.equal(firstClaim.generation, 1);
      const repeatedRequest = await repository.queueSync({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture' });
      assert.equal(repeatedRequest.state,'backfilling');
      assert.equal(repeatedRequest.generation,firstClaim.generation);
      assert.equal(repeatedRequest.claimedBy,'worker-a');
      assert.equal(repeatedRequest.leaseExpiresAt,firstClaim.leaseExpiresAt);
      assert.equal(await repository.claimDue({
        workerId:'worker-b',now:leaseNow,leaseMs:activeLeaseMs,
      }), null);
      const recoveredClaim = await repository.claimDue({ workerId:'worker-b',
        now:leaseNow+activeLeaseMs+1,leaseMs:30_000 });
      assert.equal(recoveredClaim.claimedBy, 'worker-b');
      await assert.rejects(repository.applyProviderPage({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',generation:recoveredClaim.generation,expectedCursor:null,
        workerId:'worker-a',page:{supported:true,chain:'ink',providerKey:'fixture',transactions:[],
          nextCursor:null,hasMore:false,observedHeadBlock:'200',finalizedThroughBlock:null,
          coverage:{history:null,provenance:null},recheckRange:null} }),
      error => error.code === 'WALLET_HISTORY_SYNC_STALE');
      const partial = await repository.applyProviderPage({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',generation:recoveredClaim.generation,expectedCursor:null,
        workerId:'worker-b',page:{supported:true,chain:'ink',providerKey:'fixture',transactions:[],
          nextCursor:null,hasMore:false,observedHeadBlock:'200',finalizedThroughBlock:null,
          coverage:{history:null,provenance:null},recheckRange:null} });
      assert.equal(partial.state, 'partial');
      assert.equal(partial.claimedBy, null);
      await repository.deleteSubject({userId,chain:'ink',walletAddress:address});

      await repository.registerSubject({ userId,chain:'arbitrum',walletAddress:address,
        trackingStartBlock:'250' });
      await repository.setSyncState({ userId,chain:'arbitrum',walletAddress:address,
        providerKey:'fixture',state:'error',errorCode:'RATE_LIMITED',
        errorMessage:'retry the provider request',retryAfter:new Date(leaseNow-1_000) });
      const retryClaim = await repository.claimDue({
        workerId:'worker-retry',now:leaseNow,leaseMs:30_000,
      });
      assert.equal(retryClaim.chain,'arbitrum');
      assert.equal(retryClaim.state,'error');
      assert.equal(retryClaim.claimedBy,'worker-retry');
      const repeatedRetryRequest = await repository.queueSync({
        userId,chain:'arbitrum',walletAddress:address,providerKey:'fixture',
      });
      assert.equal(repeatedRetryRequest.state,'error');
      assert.equal(repeatedRetryRequest.generation,retryClaim.generation);
      assert.deepEqual(repeatedRetryRequest.cursor,retryClaim.cursor);
      assert.equal(repeatedRetryRequest.lastErrorCode,'RATE_LIMITED');
      assert.equal(repeatedRetryRequest.claimedBy,'worker-retry');
      assert.equal(repeatedRetryRequest.leaseExpiresAt,retryClaim.leaseExpiresAt);
      assert.equal(await repository.claimDue({
        workerId:'worker-race',now:leaseNow+1_000,leaseMs:1_000,
      }),null);
      await repository.deleteSubject({userId,chain:'arbitrum',walletAddress:address});

      await repository.registerSubject({ userId,chain:'polygon',walletAddress:address,
        trackingStartBlock:'300' });
      await repository.setSyncState({ userId,chain:'polygon',walletAddress:address,
        providerKey:'fixture',state:'queued' });
      const releasable = await repository.claimDue({ workerId:'worker-c',now:leaseNow,leaseMs:30_000 });
      assert.equal(await repository.releaseClaim({userId,chain:'polygon',walletAddress:address,
        workerId:'worker-d'}),null);
      assert.equal((await repository.releaseClaim({userId,chain:'polygon',walletAddress:address,
        workerId:'worker-c'})).claimedBy,null);
      assert.equal(releasable.chain,'polygon');
      await repository.deleteSubject({userId,chain:'polygon',walletAddress:address});

      const external = await repository.listPage(userId, { chain:'ethereum', walletAddress:address,
        source:'external', limit:20, offset:0, snapshotAt:all.snapshotAt });
      assert.deepEqual(external.items.map(item => item.txHash), [externalHash]);

      const afterLastPage = await repository.listPage(userId, { chain:'ethereum', walletAddress:address,
        limit:20, offset:100, snapshotAt:all.snapshotAt });
      assert.equal(afterLastPage.total, 3);
      assert.deepEqual(afterLastPage.items, []);
      assert.equal(afterLastPage.snapshotScope, 'first_observed_at');

      const nextSync = await repository.beginSync({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture' });
      const whileBackfilling = await repository.listPage(userId, {
        chain:'ethereum', walletAddress:address, limit:20, offset:0,
      });
      assert.equal(whileBackfilling.coverage.state,'backfilling');
      assert.deepEqual(Object.fromEntries(whileBackfilling.items.map(item => [item.txHash,item.source])),{
        [ghostMintHash]:'ghostmint',
        [externalHash]:'source_unknown',
        [unknownHash]:'source_unknown',
      });
      const staleExternal = await repository.listPage(userId, {
        chain:'ethereum', walletAddress:address, source:'external', limit:20, offset:0,
      });
      assert.equal(staleExternal.total,0);
      await assert.rejects(repository.applyProviderPage({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:sync.generation, expectedCursor:null, page:{
          supported:true,chain:'ethereum',providerKey:'fixture',transactions:[],nextCursor:null,
          hasMore:false,observedHeadBlock:'102',finalizedThroughBlock:null,
          coverage:{history:null,provenance:null},recheckRange:null,
        } }), error => error.code === 'WALLET_HISTORY_SYNC_STALE');
      assert.equal(await repository.markSyncError({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:sync.generation, expectedCursor:null,
        errorCode:'STALE_WORKER',errorMessage:'must not clobber the current generation' }), null);
      await repository.applyProviderPage({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:nextSync.generation, expectedCursor:null, page:{
          supported:true,chain:'ethereum',providerKey:'fixture',
          transactions:[
            importedTransaction(ghostMintHash,101,occurredAt),
            importedTransaction(externalHash,102,occurredAt),
            importedTransaction(unknownHash,99,occurredAt),
          ],
          nextCursor:null,hasMore:false,observedHeadBlock:'102',finalizedThroughBlock:'102',coverage:{
            history:{fromBlock:'0',throughBlock:'102',complete:true},
            provenance:{fromBlock:'101',throughBlock:'102',complete:true},
          },recheckRange:{fromBlock:'0',throughBlock:'102'},
        } });
      const reconciled = await repository.listPage(userId, { chain:'ethereum', walletAddress:address,
        limit:20, offset:0 });
      assert.deepEqual(Object.fromEntries(reconciled.items.map(item => [item.txHash,item.source])),{
        [ghostMintHash]:'ghostmint',
        [externalHash]:'external',
        [unknownHash]:'source_unknown',
      });
      assert.equal(reconciled.coverage.chains[0].finalizedThroughBlock, null);

      await repository.registerSubject({ userId,chain:'robinhood',walletAddress:address,
        trackingStartBlock:'150' });
      const finalityHash=hash('7');
      const robinhoodPage=(transactions,overrides={})=>({
        supported:true,chain:'robinhood',providerKey:'fixture',transactions,
        nextCursor:null,hasMore:false,observedHeadBlock:'150',finalizedThroughBlock:'150',
        coverage:{history:null,provenance:null},recheckRange:null,
        ...overrides,
      });
      const beginRobinhoodSync=()=>repository.beginSync({
        userId,chain:'robinhood',walletAddress:address,providerKey:'fixture',
      });
      const applyRobinhoodPage=(generation,page,expectedCursor=null)=>repository.applyProviderPage({
        userId,chain:'robinhood',walletAddress:address,providerKey:'fixture',generation,
        expectedCursor,page,
      });
      const finalitySync=await repository.beginSync({ userId,chain:'robinhood',walletAddress:address,
        providerKey:'fixture' });
      await applyRobinhoodPage(finalitySync.generation,
        robinhoodPage([importedTransaction(finalityHash,150,occurredAt)]));

      const reobserveSync=await beginRobinhoodSync();
      await applyRobinhoodPage(reobserveSync.generation,
        robinhoodPage([importedTransaction(finalityHash,150,occurredAt)]));

      const sameBlockHash=hash('8');
      const sameBlockSync=await beginRobinhoodSync();
      await applyRobinhoodPage(sameBlockSync.generation,robinhoodPage([
        importedTransaction(sameBlockHash,150,occurredAt),
      ]));

      const changedBlockSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(changedBlockSync.generation,robinhoodPage([
        importedTransaction(finalityHash,151,occurredAt,{blockHash:hash('e')}),
      ],{observedHeadBlock:'151',finalizedThroughBlock:'151'})),
      error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');

      const changedHashSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(changedHashSync.generation,robinhoodPage([
        importedTransaction(finalityHash,150,occurredAt,{blockHash:hash('e')}),
      ])),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');

      const changedCanonicalSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(changedCanonicalSync.generation,robinhoodPage([
        importedTransaction(finalityHash,150,occurredAt,{canonical:false}),
      ])),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');

      const differentHashSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(differentHashSync.generation,robinhoodPage([
        importedTransaction(hash('9'),150,occurredAt,{blockHash:hash('e')}),
      ])),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');

      const unfinalizedSameBlockSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(unfinalizedSameBlockSync.generation,robinhoodPage([
        importedTransaction(hash('1'),150,occurredAt,{finalized:false}),
      ],{finalizedThroughBlock:null})),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');

      const rollbackHash=hash('2');
      const rollbackSync=await beginRobinhoodSync();
      await applyRobinhoodPage(rollbackSync.generation,robinhoodPage([],{
        nextCursor:{page:1},hasMore:true,
      }));
      await assert.rejects(applyRobinhoodPage(rollbackSync.generation,robinhoodPage([
        importedTransaction(rollbackHash,151,occurredAt,{blockHash:hash('e')}),
        importedTransaction(finalityHash,150,occurredAt,{canonical:false}),
      ],{
        nextCursor:{page:2},hasMore:true,observedHeadBlock:'151',finalizedThroughBlock:'151',
      }),{page:1}),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');
      const rolledBackWrites=await pool.query(`SELECT
          (SELECT COUNT(*)::INTEGER FROM wallet_history_transactions
            WHERE user_id=$1 AND chain='robinhood' AND wallet_address=$2 AND tx_hash=$3) AS transactions,
          (SELECT COUNT(*)::INTEGER FROM wallet_history_movements
            WHERE user_id=$1 AND chain='robinhood' AND wallet_address=$2 AND tx_hash=$3) AS movements`,
      [userId,address,rollbackHash]);
      assert.deepEqual(rolledBackWrites.rows[0],{transactions:0,movements:0});
      const rolledBackSync=(await repository.getSubject({
        userId,chain:'robinhood',walletAddress:address,
      })).sync;
      assert.equal(rolledBackSync.generation,rollbackSync.generation);
      assert.equal(rolledBackSync.state,'backfilling');
      assert.deepEqual(rolledBackSync.cursor,{page:1});

      const missingSync=await beginRobinhoodSync();
      await assert.rejects(applyRobinhoodPage(missingSync.generation,robinhoodPage([],{
        coverage:{history:{fromBlock:'0',throughBlock:'150',complete:true},provenance:null},
        recheckRange:{fromBlock:'100',throughBlock:'150'},
      })),error=>error.code==='WALLET_HISTORY_FINALIZED_CONFLICT');
      const preservedFinality=await pool.query(`SELECT finality_status,canonical,generation
        FROM wallet_history_transactions
        WHERE user_id=$1 AND chain='robinhood' AND wallet_address=$2 AND tx_hash=$3`,
      [userId,address,finalityHash]);
      assert.deepEqual(preservedFinality.rows,[{
        finality_status:'finalized',canonical:true,generation:String(reobserveSync.generation),
      }]);
      await repository.deleteSubject({userId,chain:'robinhood',walletAddress:address});

      // Removing a wallet hides its account ledger and pauses every retained address-backed
      // subject. An already-fetched provider page cannot land after that removal boundary.
      const inFlightSync = await repository.beginSync({ userId,chain:'ethereum',walletAddress:address,
        providerKey:'fixture' });
      const removalClaim=await repository.claimDue({
        workerId:'removal-worker',now:Date.now(),leaseMs:30_000,
      });
      assert.equal(removalClaim.userId,userId);
      assert.equal(removalClaim.chain,'ethereum');
      assert.equal(removalClaim.generation,inFlightSync.generation);
      assert.equal(removalClaim.claimedBy,'removal-worker');
      assert.equal(await storage.deleteWallet(userId,'history-wallet'),true);
      const removed = await pool.query(`SELECT chain,sync_enabled,last_removed_at
        FROM wallet_history_subjects WHERE user_id=$1 AND wallet_address=$2 ORDER BY chain`,
      [userId,address]);
      assert.equal(removed.rowCount,2);
      assert.equal(removed.rows.every(row=>row.sync_enabled===false && row.last_removed_at),true);
      const removedSync = await pool.query(`SELECT chain,generation,claimed_by,claimed_at,lease_expires_at
        FROM wallet_history_sync_state WHERE user_id=$1 AND wallet_address=$2`,[userId,address]);
      assert.equal(removedSync.rows.every(row=>row.claimed_by===null
        && row.claimed_at===null && row.lease_expires_at===null),true);
      assert.equal(Number(removedSync.rows.find(row=>row.chain==='ethereum').generation),
        inFlightSync.generation+1);
      const retainedIntent=await pool.query(`SELECT wallet_id FROM transaction_intents
        WHERE intent_id=$1`,[intent.rows[0].intent_id]);
      assert.deepEqual(retainedIntent.rows,[{wallet_id:null}]);
      const hidden = await repository.listAccountPage(userId,{
        supportedChains:['ethereum','base'],limit:20,offset:0,
      });
      assert.equal(hidden.total,0);
      assert.equal((await repository.listPage(userId,{
        chain:'ethereum',walletAddress:address,limit:20,offset:0,
      })).total,3,'removal must retain the finalized address-backed ledger');
      await assert.rejects(repository.applyProviderPage({
        userId,chain:'ethereum',walletAddress:address,providerKey:'fixture',
        generation:inFlightSync.generation,expectedCursor:null,workerId:'removal-worker',page:{
          supported:true,chain:'ethereum',providerKey:'fixture',transactions:[],nextCursor:null,
          hasMore:false,observedHeadBlock:'102',finalizedThroughBlock:'102',
          coverage:{history:null,provenance:null},recheckRange:null,
        },
      }),error=>error.code==='WALLET_HISTORY_SYNC_STALE');
      await assert.rejects(repository.registerSubject({
        userId,chain:'ethereum',walletAddress:address,trackingStartBlock:'102',
      }),error=>error.code==='WALLET_HISTORY_SYNC_STALE');
      await assert.rejects(repository.queueSync({
        userId,chain:'ethereum',walletAddress:address,providerKey:'fixture',
      }),error=>error.code==='WALLET_HISTORY_SYNC_STALE');

      const reimported = await storage.addWallet({
        userId,label:'history-wallet-reimported',address,chain:'ethereum',
        keyEnvelope:{ciphertext:'ciphertext-2',salt:'salt-2',nonce:'nonce-2',authTag:'tag-2',
          keyVersion:1},minted:0,addedAt:Date.now(),
      });
      assert.notEqual(reimported.id,Number(wallet.rows[0].id));
      const restored = await pool.query(`SELECT sync_enabled,last_removed_at
        FROM wallet_history_subjects WHERE user_id=$1 AND wallet_address=$2`,[userId,address]);
      assert.equal(restored.rows.every(row=>row.sync_enabled===true && row.last_removed_at===null),true);
      assert.equal(await repository.claimDue({
        workerId:'premature-reimport-worker',now:Date.now(),leaseMs:30_000,
      }),null,'reimport must not automatically resume a retained cursor');
      const requeued=await repository.queueSync({
        userId,chain:'ethereum',walletAddress:address,providerKey:'fixture',
      });
      assert.equal(requeued.state,'queued');
      assert.equal(requeued.cursor,null);
      const reimportClaim=await repository.claimDue({
        workerId:'reimport-worker',now:Date.now(),leaseMs:30_000,
      });
      assert.equal(reimportClaim.userId,userId);
      assert.equal(reimportClaim.chain,'ethereum');
      assert.equal(reimportClaim.cursor,null);
      assert.equal(reimportClaim.generation,inFlightSync.generation+2);
      await assert.rejects(repository.applyProviderPage({
        userId,chain:'ethereum',walletAddress:address,providerKey:'fixture',
        generation:inFlightSync.generation,expectedCursor:null,workerId:'removal-worker',page:{
          supported:true,chain:'ethereum',providerKey:'fixture',transactions:[],nextCursor:null,
          hasMore:false,observedHeadBlock:'102',finalizedThroughBlock:'102',
          coverage:{history:null,provenance:null},recheckRange:null,
        },
      }),error=>error.code==='WALLET_HISTORY_SYNC_STALE');
      const restoredLedger = await repository.listAccountPage(userId,{
        supportedChains:['ethereum','base'],source:'ghostmint',limit:20,offset:0,
      });
      assert.deepEqual(restoredLedger.items.map(item=>item.txHash),[ghostMintHash]);
      assert.equal(restoredLedger.items[0].walletId,reimported.id);
      assert.equal(restoredLedger.items[0].walletLabel,'history-wallet-reimported');

      // The same public address in another account is a separate tenant ledger. First-party
      // evidence never crosses that boundary, so the old GhostMint hash remains Source unknown.
      const secondUserId=randomUUID();
      cleanupUserIds.push(secondUserId);
      await pool.query('INSERT INTO users(user_id) VALUES ($1)',[secondUserId]);
      await storage.addWallet({
        userId:secondUserId,label:'other-account-wallet',address,chain:'ethereum',
        keyEnvelope:{ciphertext:'ciphertext-3',salt:'salt-3',nonce:'nonce-3',authTag:'tag-3',
          keyVersion:1},minted:0,addedAt:Date.now(),
      });
      await repository.registerSubject({userId:secondUserId,chain:'ethereum',walletAddress:address,
        trackingStartBlock:'200'});
      const secondSync=await repository.beginSync({userId:secondUserId,chain:'ethereum',
        walletAddress:address,providerKey:'fixture'});
      await repository.applyProviderPage({userId:secondUserId,chain:'ethereum',walletAddress:address,
        providerKey:'fixture',generation:secondSync.generation,page:{
          supported:true,chain:'ethereum',providerKey:'fixture',
          transactions:[importedTransaction(ghostMintHash,101,occurredAt)],
          nextCursor:null,hasMore:false,observedHeadBlock:'202',finalizedThroughBlock:'202',
          coverage:{history:null,provenance:null},recheckRange:null,
        }});
      const isolated=await repository.listAccountPage(secondUserId,{
        supportedChains:['ethereum'],limit:20,offset:0,
      });
      assert.equal(isolated.total,1);
      assert.equal(isolated.items[0].source,'source_unknown');
      await pool.query('DELETE FROM wallets WHERE user_id=$1',[secondUserId]);
      await pool.query('DELETE FROM users WHERE user_id=$1',[secondUserId]);

      // Account deletion removes owned wallets before deleting the restricted user row. Wallet
      // removal preserves the intent with a null wallet_id; deleting the user must then cascade
      // both the intent/broadcast evidence and the address-backed ledger.
      await pool.query('DELETE FROM wallets WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM users WHERE user_id=$1', [userId]);
      const leftovers = await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM wallet_history_subjects WHERE user_id=$1) AS subjects,
        (SELECT COUNT(*)::INTEGER FROM wallet_history_transactions WHERE user_id=$1) AS transactions,
        (SELECT COUNT(*)::INTEGER FROM transaction_broadcast_hashes WHERE intent_id=$2) AS hashes`,
      [userId, intent.rows[0].intent_id]);
      assert.deepEqual(leftovers.rows[0], { subjects:0, transactions:0, hashes:0 });

      // A newly-created account can re-index the public transaction, but hard account erasure has
      // removed the private intent evidence needed to call it GhostMint activity.
      const recreatedUserId=randomUUID();
      cleanupUserIds.push(recreatedUserId);
      await pool.query('INSERT INTO users(user_id) VALUES ($1)',[recreatedUserId]);
      await storage.addWallet({
        userId:recreatedUserId,label:'recreated-wallet',address,chain:'ethereum',
        keyEnvelope:{ciphertext:'ciphertext-4',salt:'salt-4',nonce:'nonce-4',authTag:'tag-4',
          keyVersion:1},minted:0,addedAt:Date.now(),
      });
      await repository.registerSubject({userId:recreatedUserId,chain:'ethereum',
        walletAddress:address,trackingStartBlock:'200'});
      const recreatedSync=await repository.beginSync({userId:recreatedUserId,chain:'ethereum',
        walletAddress:address,providerKey:'fixture'});
      await repository.applyProviderPage({userId:recreatedUserId,chain:'ethereum',
        walletAddress:address,providerKey:'fixture',generation:recreatedSync.generation,page:{
          supported:true,chain:'ethereum',providerKey:'fixture',
          transactions:[importedTransaction(ghostMintHash,101,occurredAt)],
          nextCursor:null,hasMore:false,observedHeadBlock:'202',finalizedThroughBlock:'202',
          coverage:{history:null,provenance:null},recheckRange:null,
        }});
      const recreated=await repository.listAccountPage(recreatedUserId,{
        supportedChains:['ethereum'],limit:20,offset:0,
      });
      assert.equal(recreated.items[0].source,'source_unknown');
      await pool.query('DELETE FROM wallets WHERE user_id=$1',[recreatedUserId]);
      await pool.query('DELETE FROM users WHERE user_id=$1',[recreatedUserId]);
    } finally {
      await pool.query('DELETE FROM wallets WHERE user_id=ANY($1::UUID[])', [cleanupUserIds])
        .catch(() => {});
      await pool.query('DELETE FROM users WHERE user_id=ANY($1::UUID[])', [cleanupUserIds])
        .catch(() => {});
      await pool.end();
    }
  });
