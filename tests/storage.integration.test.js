const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createKeyEncryption, KeyDecryptionError } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('wallet data survives a pool restart and tampering fails authentication', { timeout: 30_000 }, async () => {
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
  const inserted = await firstStorage.addWallet({
    label, address: '0x0000000000000000000000000000000000000001', chain: 'ethereum',
    keyEnvelope: crypto.encrypt(privateKey), minted: 0, addedAt: Date.now(),
  });
  await firstStorage.close();

  const secondPool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const secondStorage = createPostgresStorage(secondPool);
  try {
    const state = await secondStorage.loadState();
    const reloaded = state.wallets.find(wallet => wallet.label === label);
    assert.ok(reloaded, 'wallet must exist after reconnecting with a new pool');
    assert.equal(crypto.decrypt(reloaded.keyEnvelope), privateKey);

    const tampered = { ...reloaded.keyEnvelope, authTag: Buffer.alloc(16).toString('base64') };
    assert.throws(() => crypto.decrypt(tampered), KeyDecryptionError);
  } finally {
    await secondStorage.deleteWallet(label);
    await secondStorage.close();
  }

  assert.equal(inserted.keyEnvelope.keyVersion, CONFIG.encryptionKeyVersion);
});
