const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const { createWalletHistoryProviderRegistry } = require('../src/walletHistory/provider');
const { createWalletHistoryRepository } = require('../src/walletHistory/repository');
const { createWalletHistoryService } = require('../src/walletHistory/service');
const { createWalletHistoryWorker } = require('../src/walletHistory/worker');
const {
  createTestDatabasePool,
  integrationTest,
  runTestMigrations,
} = require('./helpers/disposableDatabase');

const CHAIN = 'ethereum';
const PROVIDER_KEY = 'goldrush-canary-fixture';
const WALLET_ADDRESS = '0x0000000000000000000000000000000000000ca7';
const TARGET_ADDRESS = '0x0000000000000000000000000000000000000cab';

function hashFor(runId, label) {
  return `0x${createHash('sha256').update(`${runId}:${label}`).digest('hex')}`;
}

function transaction(runId, label, blockNumber, overrides = {}) {
  return {
    txHash:hashFor(runId, `tx:${label}`),
    blockNumber:String(blockNumber),
    blockHash:hashFor(runId, `block:${label}:${overrides.blockVersion || 'one'}`),
    transactionIndex:'0',
    occurredAt:'2026-10-14T12:00:00.000Z',
    fromAddress:WALLET_ADDRESS,
    toAddress:TARGET_ADDRESS,
    nonce:String(blockNumber),
    input:'0x',
    methodSelector:null,
    valueWei:overrides.valueWei || '10',
    gasLimit:'21000',
    gasUsed:'21000',
    effectiveGasPriceWei:'1',
    networkFeeWei:'21000',
    executionStatus:'success',
    finalityStatus:'unfinalized',
    canonical:true,
    rawSummary:{ fixture:true, label },
    movements:[{
      eventLocator:'native:value',
      eventType:'native_transfer',
      direction:'out',
      assetStandard:'native',
      assetAddress:null,
      tokenId:null,
      amountRaw:overrides.valueWei || '10',
      fromAddress:WALLET_ADDRESS,
      toAddress:TARGET_ADDRESS,
      details:{ fixture:true },
    }],
  };
}

function incompleteCoverage() {
  return { history:null, provenance:null };
}

function completeCoverage() {
  return {
    history:{ fromBlock:'0', throughBlock:'400', complete:true },
    provenance:{ fromBlock:'100', throughBlock:'400', complete:true },
  };
}

function fixturePage(runId, scenario, cursor) {
  const a = transaction(runId, 'a', 110);
  const b = transaction(runId, 'b', 300);
  const c = transaction(runId, 'c', 150);
  const d = transaction(runId, 'd', 180);
  if (scenario === 'initial') {
    if (cursor === null) {
      return {
        chain:CHAIN,
        providerKey:PROVIDER_KEY,
        transactions:[a, b],
        nextCursor:{ page:1 },
        hasMore:true,
        observedHeadBlock:'400',
        finalizedThroughBlock:'0',
        coverage:incompleteCoverage(),
        recheckRange:null,
      };
    }
    assert.deepEqual(cursor, { page:1 });
    return {
      chain:CHAIN,
      providerKey:PROVIDER_KEY,
      transactions:[b, c],
      nextCursor:null,
      hasMore:false,
      observedHeadBlock:'400',
      finalizedThroughBlock:'0',
      coverage:incompleteCoverage(),
      recheckRange:null,
    };
  }
  if (scenario === 'complete') {
    assert.equal(cursor, null);
    return {
      chain:CHAIN,
      providerKey:PROVIDER_KEY,
      transactions:[a, b, c],
      nextCursor:null,
      hasMore:false,
      observedHeadBlock:'400',
      finalizedThroughBlock:'0',
      coverage:completeCoverage(),
      recheckRange:{ fromBlock:'0', throughBlock:'400' },
    };
  }
  if (scenario === 'bounded-recheck') {
    assert.equal(cursor, null);
    return {
      chain:CHAIN,
      providerKey:PROVIDER_KEY,
      transactions:[transaction(runId, 'a', 110, {
        valueWei:'99', blockVersion:'two',
      }), d],
      nextCursor:null,
      hasMore:false,
      observedHeadBlock:'400',
      finalizedThroughBlock:'0',
      coverage:completeCoverage(),
      recheckRange:{ fromBlock:'100', throughBlock:'200' },
    };
  }
  throw new Error(`Unknown fixture scenario: ${scenario}`);
}

function failureInjectingPool(pool) {
  return {
    query(...args) {
      return pool.query(...args);
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (/UPDATE\s+wallet_history_transactions\s+SET\s+canonical=FALSE/i.test(String(text))) {
            const error = new Error('Synthetic cleanup failure');
            error.code = 'SYNTHETIC_CLEANUP_FAILURE';
            throw error;
          }
          return client.query(text, values);
        },
        release() {
          client.release();
        },
      };
    },
  };
}

async function transactionRows(pool, userId) {
  const result = await pool.query(`SELECT tx_hash,block_number,block_hash,value_wei,canonical,
      provider_complete,generation
    FROM wallet_history_transactions
    WHERE user_id=$1 AND chain=$2 AND wallet_address=$3
    ORDER BY block_number,tx_hash`, [userId, CHAIN, WALLET_ADDRESS]);
  return result.rows;
}

integrationTest('GoldRush wallet-history canary composes worker, service, registry, and repository safely',
  { timeout:120_000 }, async () => {
    await runTestMigrations({ migrationsDirectory:path.resolve(__dirname, '../migrations') });
    const pool = await createTestDatabasePool({ max:3 });
    const repository = createWalletHistoryRepository(pool);
    const runId = randomUUID();
    const userId = randomUUID();
    let scenario = 'initial';
    const requests = [];
    let cleaned = false;

    const adapter = {
      providerKey:PROVIDER_KEY,
      label:'GoldRush canary fixture',
      chains:[CHAIN],
      capabilities:{ transactions:true, movements:true, receipts:true },
      async fetchPage(request) {
        requests.push({ scenario, cursor:request.cursor });
        return fixturePage(runId, scenario, request.cursor);
      },
    };
    const providerRegistry = createWalletHistoryProviderRegistry({ adapters:[adapter] });
    const service = createWalletHistoryService({
      repository,
      providerRegistry,
      defaultProviderKey:PROVIDER_KEY,
      supportedChains:[CHAIN],
      syncEnabled:true,
    });

    try {
      await pool.query('INSERT INTO users(user_id) VALUES ($1)', [userId]);
      // A known tracking boundary is required before imported rows can ever be classified as
      // External. Re-registering the subject through requestSync preserves this first boundary.
      await repository.registerSubject({
        userId,
        chain:CHAIN,
        walletAddress:WALLET_ADDRESS,
        trackingStartBlock:'99',
      });
      const queued = await service.requestSync(userId, {
        address:WALLET_ADDRESS,
        chain:CHAIN,
      }, { chain:CHAIN });
      assert.equal(queued.state, 'queued');

      const firstWorker = createWalletHistoryWorker({
        repository,
        service,
        workerId:`canary-${runId}-one`,
      });
      assert.equal(await firstWorker.tick(), true);
      const afterFirstPage = await repository.getSubject({
        userId, chain:CHAIN, walletAddress:WALLET_ADDRESS,
      });
      assert.equal(afterFirstPage.sync.state, 'backfilling');
      assert.equal(afterFirstPage.sync.generation, 1);
      assert.deepEqual(afterFirstPage.sync.cursor, { page:1 });
      assert.deepEqual(requests.at(-1), { scenario:'initial', cursor:null });

      // A newly constructed worker represents a process restart. It must resume the same
      // generation and stored cursor rather than starting page zero again.
      const restartedWorker = createWalletHistoryWorker({
        repository,
        service,
        workerId:`canary-${runId}-two`,
      });
      assert.equal(await restartedWorker.tick(), true);
      const afterSecondPage = await repository.getSubject({
        userId, chain:CHAIN, walletAddress:WALLET_ADDRESS,
      });
      assert.equal(afterSecondPage.sync.state, 'partial');
      assert.equal(afterSecondPage.sync.generation, 1);
      assert.equal(afterSecondPage.sync.cursor, null);
      assert.deepEqual(requests.at(-1), { scenario:'initial', cursor:{ page:1 } });

      const initialHistory = await repository.listPage(userId, {
        chain:CHAIN, walletAddress:WALLET_ADDRESS, limit:20, offset:0,
      });
      assert.deepEqual(initialHistory.items.map(item => item.txHash).sort(), [
        hashFor(runId, 'tx:a'), hashFor(runId, 'tx:b'), hashFor(runId, 'tx:c'),
      ].sort());
      assert.equal(initialHistory.total, 3);
      assert.equal(initialHistory.coverage.state, 'partial');
      assert.equal(initialHistory.items.every(item => item.source === 'source_unknown'), true);
      const incompleteRows = await transactionRows(pool, userId);
      assert.equal(incompleteRows.length, 3);
      assert.equal(incompleteRows.every(row => row.canonical === true), true);
      assert.equal(incompleteRows.every(row => row.provider_complete === false), true);

      // Only an explicit complete history/provenance claim may make rows complete and eligible
      // for External attribution.
      scenario = 'complete';
      assert.equal((await service.requestSync(userId, {
        address:WALLET_ADDRESS, chain:CHAIN,
      }, { chain:CHAIN })).state, 'queued');
      const completeWorker = createWalletHistoryWorker({
        repository,
        service,
        workerId:`canary-${runId}-complete`,
      });
      assert.equal(await completeWorker.tick(), true);
      const completeHistory = await repository.listPage(userId, {
        chain:CHAIN, walletAddress:WALLET_ADDRESS, limit:20, offset:0,
      });
      assert.equal(completeHistory.coverage.state, 'current');
      assert.equal(completeHistory.items.length, 3);
      assert.equal(completeHistory.items.every(item => item.source === 'external'), true);

      // Make one generation stale before it can write. Neither the proposed update nor its
      // reconciliation range may affect durable rows.
      const stale = await repository.beginSync({
        userId, chain:CHAIN, walletAddress:WALLET_ADDRESS, providerKey:PROVIDER_KEY,
      });
      const current = await repository.beginSync({
        userId, chain:CHAIN, walletAddress:WALLET_ADDRESS, providerKey:PROVIDER_KEY,
      });
      assert.equal(current.generation, stale.generation + 1);
      await assert.rejects(repository.applyProviderPage({
        userId,
        chain:CHAIN,
        walletAddress:WALLET_ADDRESS,
        providerKey:PROVIDER_KEY,
        generation:stale.generation,
        expectedCursor:null,
        page:fixturePage(runId, 'bounded-recheck', null),
      }), error => error?.code === 'WALLET_HISTORY_SYNC_STALE');
      let durableRows = await transactionRows(pool, userId);
      assert.equal(durableRows.some(row => row.tx_hash === hashFor(runId, 'tx:d')), false);
      assert.equal(durableRows.find(row => row.tx_hash === hashFor(runId, 'tx:a')).value_wei, '10');
      assert.equal(durableRows.find(row => row.tx_hash === hashFor(runId, 'tx:c')).canonical, true);

      // Inject a database failure exactly at reconciliation. The transaction updates that occur
      // before cleanup and the cleanup itself must all roll back, leaving this generation resumable.
      const failingRepository = createWalletHistoryRepository(failureInjectingPool(pool));
      await assert.rejects(failingRepository.applyProviderPage({
        userId,
        chain:CHAIN,
        walletAddress:WALLET_ADDRESS,
        providerKey:PROVIDER_KEY,
        generation:current.generation,
        expectedCursor:null,
        page:fixturePage(runId, 'bounded-recheck', null),
      }), error => error?.code === 'SYNTHETIC_CLEANUP_FAILURE');
      durableRows = await transactionRows(pool, userId);
      assert.equal(durableRows.some(row => row.tx_hash === hashFor(runId, 'tx:d')), false);
      assert.equal(durableRows.find(row => row.tx_hash === hashFor(runId, 'tx:a')).value_wei, '10');
      assert.equal(durableRows.find(row => row.tx_hash === hashFor(runId, 'tx:c')).canonical, true);
      const afterRollback = await repository.getSubject({
        userId, chain:CHAIN, walletAddress:WALLET_ADDRESS,
      });
      assert.equal(afterRollback.sync.generation, current.generation);
      assert.equal(afterRollback.sync.state, 'backfilling');
      assert.equal(afterRollback.sync.cursor, null);

      // The successfully restarted bounded recheck updates A, introduces D, and orphans only C.
      // B is outside the 100-200 block reconciliation window and must survive even when omitted.
      scenario = 'bounded-recheck';
      const recheckWorker = createWalletHistoryWorker({
        repository,
        service,
        workerId:`canary-${runId}-recheck`,
      });
      assert.equal(await recheckWorker.tick(), true);
      durableRows = await transactionRows(pool, userId);
      const byHash = Object.fromEntries(durableRows.map(row => [row.tx_hash, row]));
      assert.equal(byHash[hashFor(runId, 'tx:a')].value_wei, '99');
      assert.equal(byHash[hashFor(runId, 'tx:a')].generation, String(current.generation));
      assert.equal(byHash[hashFor(runId, 'tx:b')].canonical, true);
      assert.equal(byHash[hashFor(runId, 'tx:c')].canonical, false);
      assert.equal(byHash[hashFor(runId, 'tx:d')].canonical, true);

      const reconciledHistory = await repository.listPage(userId, {
        chain:CHAIN, walletAddress:WALLET_ADDRESS, limit:20, offset:0,
      });
      assert.deepEqual(reconciledHistory.items.map(item => item.txHash).sort(), [
        hashFor(runId, 'tx:a'), hashFor(runId, 'tx:b'), hashFor(runId, 'tx:d'),
      ].sort());

      await pool.query('DELETE FROM users WHERE user_id=$1', [userId]);
      const residue = await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM wallet_history_subjects WHERE user_id=$1) AS subjects,
        (SELECT COUNT(*)::INTEGER FROM wallet_history_transactions WHERE user_id=$1) AS transactions`,
      [userId]);
      assert.deepEqual(residue.rows[0], { subjects:0, transactions:0 });
      cleaned = true;
    } finally {
      if (!cleaned) {
        await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
      }
      await pool.end();
    }
  });
