const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createPostgresGovernanceRepository } = require('../src/governance/postgresGovernanceRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { createLiveAcceptanceRunRepository } = require('../src/acceptance/liveAcceptanceRunRepository');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('live acceptance runs persist durably and stay owner-scoped', { timeout: 30_000 }, async () => {
  await runMigrations({
    connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const storage = createPostgresStorage(pool);
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const governanceRepository = createPostgresGovernanceRepository(pool);
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  const runRepository = createLiveAcceptanceRunRepository(pool);

  try {
    const userId = await identity.resolveOrCreate('telegram', `acceptance-${process.pid}-${Date.now()}`);
    await governanceRepository.setOwner(userId, true);
    const wallet = await storage.addWallet({
      userId, label: `acceptance-${process.pid}-${Date.now()}`,
      address: '0x0000000000000000000000000000000000000002', chain: 'sepolia',
      keyEnvelope: crypto.encrypt(`0x${'56'.repeat(32)}`), minted: 0, addedAt: Date.now(),
    });

    const passed = await runRepository.record({
      operatorUserId: userId, chain: 'sepolia', contractAddress: '0x00000000000000000000000000000000000000bb',
      walletId: wallet.id, methodSignature: 'mint()', intentId: null, outcome: 'passed',
      simulationPerformed: true, policySnapshot: { simulationEnabled: true }, evidence: { stage: 'submit' },
      startedAt: Date.now(),
    });
    assert.equal(passed.outcome, 'passed');
    assert.equal(passed.walletId, wallet.id);

    await assert.rejects(runRepository.record({
      operatorUserId: userId, chain: 'sepolia', contractAddress: '0x00000000000000000000000000000000000000bb',
      walletId: wallet.id, methodSignature: 'mint()', intentId: null, outcome: 'failed',
      failureCode: null, failureReason: null, simulationPerformed: true,
      policySnapshot: {}, evidence: {}, startedAt: Date.now(),
    }), 'a failed outcome without a failure code must violate the check constraint');

    const failed = await runRepository.record({
      operatorUserId: userId, chain: 'sepolia', contractAddress: '0x00000000000000000000000000000000000000bb',
      walletId: wallet.id, methodSignature: 'mint()', intentId: null, outcome: 'failed',
      failureCode: 'NOT_TESTNET', failureReason: 'chain not testnet', simulationPerformed: false,
      policySnapshot: {}, evidence: { stage: 'chain-guard' }, startedAt: Date.now(),
    });
    assert.equal(failed.failureCode, 'NOT_TESTNET');

    const runs = await runRepository.listForOperator(userId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.operatorUserId === userId));
  } finally {
    await storage.close();
  }
});
