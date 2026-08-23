const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createKeyEncryption, KeyDecryptionError } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('wallet data survives a pool restart and tampering fails authentication', { timeout: 120_000 }, async () => {
  const migration = await runMigrations({
    connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });
  assert.equal(migration.connection, 'unpooled');

  const label = `integration-${process.pid}-${Date.now()}`;
  const privateKey = `0x${'34'.repeat(32)}`;
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });

  const firstPool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const firstStorage = createPostgresStorage(firstPool);
  const identity = createIdentityService(createPostgresIdentityRepository(firstPool));
  const userId = await identity.resolveOrCreate('telegram', `storage-${process.pid}-${Date.now()}`);
  const inserted = await firstStorage.addWallet({
    userId, label, address: '0x0000000000000000000000000000000000000001', chain: 'ethereum',
    keyEnvelope: crypto.encrypt(privateKey), minted: 0, addedAt: Date.now(),
  });
  await firstStorage.close();

  const secondPool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const secondStorage = createPostgresStorage(secondPool);
  try {
    const state = await secondStorage.loadState(userId);
    const reloaded = state.wallets.find(wallet => wallet.label === label);
    assert.ok(reloaded, 'wallet must exist after reconnecting with a new pool');
    assert.equal(crypto.decrypt(reloaded.keyEnvelope), privateKey);

    const tampered = { ...reloaded.keyEnvelope, authTag: Buffer.alloc(16).toString('base64') };
    assert.throws(() => crypto.decrypt(tampered), KeyDecryptionError);
  } finally {
    await secondStorage.deleteWallet(userId, label);
    await secondStorage.close();
  }

  assert.equal(inserted.keyEnvelope.keyVersion, CONFIG.encryptionKeyVersion);
});

integrationTest('listActivityPage search filters at the database level, not just the currently-loaded page', { timeout: 120_000 }, async () => {
  const migration = await runMigrations({
    connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });
  assert.equal(migration.connection, 'unpooled');

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const storage = createPostgresStorage(pool);
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const userId = await identity.resolveOrCreate('telegram', `search-activity-${process.pid}-${Date.now()}`);
  try {
    const base = Date.now();
    // The matching entry is the OLDEST of the nine (listActivityPage orders occurred_at DESC), so it
    // sorts into what would be page two -- a bug that filtered only the already-fetched page (limit:5)
    // would never see it.
    await storage.addActivity({ userId, status:'success', title:'Findme special mint', walletLabel:null,
      txHash:null, explorer:null, time: base - 9_000 });
    for (let i = 0; i < 8; i++) {
      await storage.addActivity({ userId, status:'success', title:`Unrelated event ${i}`, walletLabel:null,
        txHash:null, explorer:null, time: base - (8 - i) * 1000 });
    }

    const page = await storage.listActivityPage(userId, { limit:5, offset:0, search:'findme' });
    assert.equal(page.total, 1, 'total must reflect only the matching row, not the unfiltered first page');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].title, 'Findme special mint');

    const unfiltered = await storage.listActivityPage(userId, { limit:5, offset:0 });
    assert.equal(unfiltered.total, 9, 'without a search term every activity row for the user is still counted');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await storage.close();
  }
});
