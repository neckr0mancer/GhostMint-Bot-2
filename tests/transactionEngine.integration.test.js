const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { createTransactionIntentRepository } = require('../src/transactions/intentRepository');
const { createTransactionPolicyRepository } = require('../src/transactions/policyRepository');
const { createTransactionEngine } = require('../src/transactions/transactionEngine');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('persisted submitted intent and editable policies survive a process-style pool restart', { timeout: 30_000 }, async () => {
  const migration = await runMigrations({
    connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });
  assert.equal(migration.connection, 'unpooled');

  const platformId = `transaction-${process.pid}-${Date.now()}`;
  const txHash = `0x${'cd'.repeat(32)}`;
  let userId;
  let wallet;
  const firstPool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  try {
    const identity = createIdentityService(createPostgresIdentityRepository(firstPool));
    userId = await identity.resolveOrCreate('telegram', platformId);
    const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
    wallet = await createPostgresStorage(firstPool).addWallet({
      userId,
      label: `tx-wallet-${Date.now()}`,
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      keyEnvelope: crypto.encrypt(`0x${'21'.repeat(32)}`),
      addedAt: Date.now(),
    });
    const policies = createTransactionPolicyRepository(firstPool);
    await policies.setPolicy({
      userId, scopeType: 'wallet', scopeId: wallet.id,
      settings: { simulationEnabled: false, maxTransactionValueWei: 123n, requiredConfirmations: 2 },
    });
    await policies.setPolicy({
      userId, scopeType: 'target', scopeId: 'target-a',
      settings: { simulationEnabled: true, requiredConfirmations: 3 },
    });
    const resolved = await policies.resolvePolicy({ userId, walletId: wallet.id, targetId: 'target-a', chain: 'ethereum' });
    assert.equal(resolved.simulationEnabled, true);
    assert.equal(resolved.maxTransactionValueWei, 123n);
    assert.equal(resolved.requiredConfirmations, 3);

    const intents = createTransactionIntentRepository(firstPool);
    const intentInput = {
      userId, walletId: wallet.id, targetId: null, chain: 'ethereum',
      from: wallet.address, to: '0x0000000000000000000000000000000000000002', data: '0x',
      valueWei: 0n, nonce: 4, gasLimit: 21_000n, gasPriceWei: 1n,
      maxFeePerGasWei: null, maxPriorityFeePerGasWei: null, estimatedCostWei: 21_000n,
      simulationEnabled: true, requiredConfirmations: 2, transactionTimeoutMs: 60_000,
      timeoutAt: Date.now() + 60_000,
    };
    const intent = await intents.createSubmitted(intentInput);
    await assert.rejects(intents.createSubmitted(intentInput), error => error.code === '23505');
    await intents.attachSignedHash(intent.intentId, txHash);
  } finally {
    await firstPool.end();
  }

  const secondPool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  try {
    const intents = createTransactionIntentRepository(secondPool);
    const engine = createTransactionEngine({
      providerService: {
        perform: (chain, name, operation) => operation({
          getTransactionReceipt: async () => ({ status: 1, blockNumber: 200 }),
          getBlockNumber: async () => 201,
        }),
      },
      intentRepository: intents,
      policyRepository: createTransactionPolicyRepository(secondPool),
      decryptPrivateKey: () => { throw new Error('reconciliation must not decrypt or sign'); },
    });
    const [reconciled] = await engine.reconcileNonFinal();
    assert.equal(reconciled.txHash, txHash);
    assert.equal(reconciled.state, 'confirmed');
    const stored = await intents.get(reconciled.intentId);
    assert.equal(stored.state, 'confirmed');
    assert.equal(await createPostgresStorage(secondPool).deleteWallet(userId, wallet.label), true);
    const retained = await intents.get(reconciled.intentId);
    assert.equal(retained.state, 'confirmed');
    assert.equal(retained.walletId, null, 'wallet removal must preserve transaction history');
  } finally {
    if (userId) {
      await secondPool.query('DELETE FROM transaction_intents WHERE user_id=$1', [userId]).catch(() => {});
      await secondPool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    }
    await secondPool.end();
  }
});

// Regression test for the daily-budget under-count (PROJECT_REVIEW §1.1): actual_network_cost_wei
// holds GAS ONLY once a receipt lands, so the old COALESCE(actual, estimated) dropped a confirmed
// mint's entire value from the 24h rolling spend -- a 0.5 ETH mint counted as ~15k wei of gas and
// the daily budget did not hold. Actuals must be topped back up with the intent's own value; the
// pre-receipt estimate already includes value and must be used as-is. Run against the real schema
// because this is exactly the kind of column-semantics assumption a mocked pool would wave through.
integrationTest('rollingSpendWei counts value plus actual fee for confirmed intents, and the estimate before one', { timeout: 30_000 }, async () => {
  const platformId = `rollingspend-${process.pid}-${Date.now()}`;
  let userId;
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  try {
    const identity = createIdentityService(createPostgresIdentityRepository(pool));
    userId = await identity.resolveOrCreate('telegram', platformId);
    const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
    const wallet = await createPostgresStorage(pool).addWallet({
      userId,
      label: `spend-wallet-${Date.now()}`,
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      keyEnvelope: crypto.encrypt(`0x${'31'.repeat(32)}`),
      addedAt: Date.now(),
    });
    const intents = createTransactionIntentRepository(pool);
    const base = {
      userId, walletId: wallet.id, targetId: null, chain: 'ethereum',
      from: wallet.address, to: '0x0000000000000000000000000000000000000002', data: '0x',
      gasPriceWei: 1n, maxFeePerGasWei: null, maxPriorityFeePerGasWei: null,
      simulationEnabled: false, requiredConfirmations: 1, transactionTimeoutMs: 60_000,
      timeoutAt: Date.now() + 60_000,
    };
    // Confirmed mint: 0.5 ETH value, estimated 21k gas, actual fee 15k wei on the receipt.
    const confirmed = await intents.createSubmitted({
      ...base, nonce: 10, valueWei: 500_000_000_000_000_000n,
      gasLimit: 21_000n, estimatedCostWei: 500_000_000_000_000_000n + 21_000n,
    });
    await intents.attachSignedHash(confirmed.intentId, `0x${'ef'.repeat(32)}`);
    await intents.transition(confirmed.intentId, 'confirmed', {
      reason: 'integration fixture', blockNumber: 300,
      gasUsed: 15_000n, effectiveGasPriceWei: 1n, actualNetworkCostWei: 15_000n,
    });
    // Submitted intent, never broadcast: estimate only (30k gas, no value).
    await intents.createSubmitted({
      ...base, nonce: 11, valueWei: 0n,
      gasLimit: 30_000n, estimatedCostWei: 30_000n,
    });

    const spent = await intents.rollingSpendWei(userId, wallet.id, Date.now() - 86_400_000);
    const expected = (15_000n + 500_000_000_000_000_000n) + 30_000n;
    assert.equal(spent, expected,
      'confirmed intent must count actual fee PLUS its mint value; the submitted one its estimate');

    // The old formula's answer, for contrast: it would have returned 15_000n + 30_000n, silently
    // excusing the entire 0.5 ETH mint from the daily budget.
    assert.notEqual(spent, 45_000n);
  } finally {
    if (userId) {
      await pool.query('DELETE FROM transaction_intents WHERE user_id=$1', [userId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    }
    await pool.end();
  }
});
