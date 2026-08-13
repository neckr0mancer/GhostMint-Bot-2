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
