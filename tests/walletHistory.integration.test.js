const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const { createWalletHistoryRepository } = require('../src/walletHistory/repository');
const { createTestDatabasePool, integrationTest, runTestMigrations } = require('./helpers/disposableDatabase');

const address = '0x00000000000000000000000000000000000000a7';
const target = '0x00000000000000000000000000000000000000b8';
const runHashSuffix = randomBytes(4).toString('hex');
const hash = digit => `0x${digit.repeat(56)}${runHashSuffix}`;

function importedTransaction(txHash, blockNumber, occurredAt) {
  return {
    txHash,
    blockNumber:String(blockNumber),
    blockHash:hash('f'),
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
    finalityStatus:'finalized',
    canonical:true,
    rawSummary:null,
    movements:[{
      eventLocator:'native:value',eventType:'native_transfer',direction:'out',assetStandard:'native',
      assetAddress:null,tokenId:null,amountRaw:'0',fromAddress:address,toAddress:target,details:null,
    }],
  };
}

integrationTest('wallet history migration stores pages and derives provenance from durable GhostMint evidence',
  { timeout: 120_000 }, async () => {
    await runTestMigrations({ migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
    const pool = await createTestDatabasePool({ max: 2 });
    const repository = createWalletHistoryRepository(pool);
    const userId = randomUUID();
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
          coverage:{
            history:{fromBlock:'0',throughBlock:'102',complete:true},
            provenance:{fromBlock:'101',throughBlock:'102',complete:true},
          },
          recheckRange:{fromBlock:'0',throughBlock:'102'},
        } });
      assert.equal(state.state, 'current');

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
          nextCursor:{page:1},hasMore:true,observedHeadBlock:'101',coverage:{
            history:null,provenance:null,
          },recheckRange:null,
        } });
      await repository.applyProviderPage({ userId, chain:'base', walletAddress:address,
        providerKey:'fixture', generation:baseSync.generation, expectedCursor:{page:1}, page:{
          supported:true,chain:'base',providerKey:'fixture',
          transactions:[importedTransaction(hash('6'),101,occurredAt)],
          nextCursor:null,hasMore:false,observedHeadBlock:'101',coverage:{
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

      await repository.registerSubject({ userId,chain:'ink',walletAddress:address,
        trackingStartBlock:'200' });
      await repository.setSyncState({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',state:'queued' });
      const leaseNow = Date.now();
      const firstClaim = await repository.claimDue({ workerId:'worker-a',now:leaseNow,leaseMs:1_000 });
      assert.equal(firstClaim.chain, 'ink');
      assert.equal(firstClaim.state, 'backfilling');
      assert.equal(firstClaim.generation, 1);
      const repeatedRequest = await repository.queueSync({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture' });
      assert.equal(repeatedRequest.state,'backfilling');
      assert.equal(repeatedRequest.generation,firstClaim.generation);
      assert.equal(repeatedRequest.claimedBy,'worker-a');
      assert.equal(repeatedRequest.leaseExpiresAt,firstClaim.leaseExpiresAt);
      assert.equal(await repository.claimDue({ workerId:'worker-b',now:leaseNow,leaseMs:1_000 }), null);
      const recoveredClaim = await repository.claimDue({ workerId:'worker-b',
        now:leaseNow+1_001,leaseMs:30_000 });
      assert.equal(recoveredClaim.claimedBy, 'worker-b');
      await assert.rejects(repository.applyProviderPage({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',generation:recoveredClaim.generation,expectedCursor:null,
        workerId:'worker-a',page:{supported:true,chain:'ink',providerKey:'fixture',transactions:[],
          nextCursor:null,hasMore:false,observedHeadBlock:'200',
          coverage:{history:null,provenance:null},recheckRange:null} }),
      error => error.code === 'WALLET_HISTORY_SYNC_STALE');
      const partial = await repository.applyProviderPage({ userId,chain:'ink',walletAddress:address,
        providerKey:'fixture',generation:recoveredClaim.generation,expectedCursor:null,
        workerId:'worker-b',page:{supported:true,chain:'ink',providerKey:'fixture',transactions:[],
          nextCursor:null,hasMore:false,observedHeadBlock:'200',
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
      await assert.rejects(repository.applyProviderPage({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:sync.generation, expectedCursor:null, page:{
          supported:true,chain:'ethereum',providerKey:'fixture',transactions:[],nextCursor:null,
          hasMore:false,observedHeadBlock:'102',coverage:{history:null,provenance:null},recheckRange:null,
        } }), error => error.code === 'WALLET_HISTORY_SYNC_STALE');
      assert.equal(await repository.markSyncError({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:sync.generation, expectedCursor:null,
        errorCode:'STALE_WORKER',errorMessage:'must not clobber the current generation' }), null);
      await repository.applyProviderPage({ userId, chain:'ethereum', walletAddress:address,
        providerKey:'fixture', generation:nextSync.generation, expectedCursor:null, page:{
          supported:true,chain:'ethereum',providerKey:'fixture',
          transactions:[importedTransaction(ghostMintHash,101,occurredAt)],
          nextCursor:null,hasMore:false,observedHeadBlock:'102',coverage:{
            history:{fromBlock:'0',throughBlock:'102',complete:true},
            provenance:{fromBlock:'101',throughBlock:'102',complete:true},
          },recheckRange:{fromBlock:'0',throughBlock:'102'},
        } });
      const reconciled = await repository.listPage(userId, { chain:'ethereum', walletAddress:address,
        limit:20, offset:0 });
      assert.deepEqual(reconciled.items.map(item => item.txHash), [ghostMintHash]);

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
    } finally {
      await pool.query('DELETE FROM wallets WHERE user_id=$1', [userId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
      await pool.end();
    }
  });
