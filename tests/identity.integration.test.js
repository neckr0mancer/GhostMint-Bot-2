const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { LinkCodeError, createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { ValidationError, requestSchemas } = require('../src/validation/domain');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

async function migrate() {
  await runMigrations({
    connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });
}

integrationTest('different Telegram accounts automatically resolve to different stable users', { timeout: 30_000 }, async () => {
  await migrate();
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const first = await identity.resolveOrCreate('telegram', `telegram-a-${suffix}`);
    const second = await identity.resolveOrCreate('telegram', `telegram-b-${suffix}`);
    assert.notEqual(first, second);
    assert.equal(await identity.resolveOrCreate('telegram', `telegram-a-${suffix}`), first);
  } finally {
    await pool.end();
  }
});

integrationTest('a first-seen Discord account is created and can link into an existing Telegram identity', { timeout: 30_000 }, async () => {
  await migrate();
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  const identity = createIdentityService(repository);
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const standalone = await identity.resolveOrCreate('discord', `standalone-discord-${suffix}`);
    assert.equal(await identity.resolveOrCreate('discord', `standalone-discord-${suffix}`), standalone);
    const telegramUser = await identity.resolveOrCreate('telegram', `telegram-link-${suffix}`);
    const link = await identity.createLinkCode(telegramUser);
    assert.equal(await identity.consumeLinkCode({ code: link.code, platform: 'discord',
      platformUserId: `linked-discord-${suffix}` }), telegramUser);
    assert.equal(await identity.resolveOrCreate('discord', `linked-discord-${suffix}`), telegramUser);
  } finally { await pool.end(); }
});

integrationTest('wallet and task repository operations cannot cross Telegram user ownership', { timeout: 30_000 }, async () => {
  await migrate();
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  const identity = createIdentityService(repository);
  const storage = createPostgresStorage(pool);
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  const suffix = `${process.pid}-${Date.now()}`;
  const walletLabel = `owned-${suffix}`;
  const taskId = randomUUID();
  try {
    const ownerId = await identity.resolveOrCreate('telegram', `owner-${suffix}`);
    const attackerId = await identity.resolveOrCreate('telegram', `attacker-${suffix}`);
    await storage.addWallet({ userId: ownerId, label: walletLabel,
      address: '0x0000000000000000000000000000000000000002', chain: 'ethereum',
      keyEnvelope: crypto.encrypt(`0x${'56'.repeat(32)}`), minted: 0, addedAt: Date.now() });
    await storage.saveTask({ userId: ownerId, id: taskId, name: 'owned task', walletLabel,
      contract: '0x0000000000000000000000000000000000000003', fn: 'mint', qty: 1,
      price: 0, gas: null, mintTime: Date.now() + 60_000, status: 'waiting', createdAt: Date.now() });

    const attackerState = await storage.loadState(attackerId);
    assert.equal(attackerState.wallets.some(wallet => wallet.label === walletLabel), false);
    assert.equal(attackerState.tasks.some(task => task.id === taskId), false);
    assert.equal(await storage.deleteWallet(attackerId, walletLabel), false);
    assert.equal(await storage.deleteTask(attackerId, taskId), false);
    assert.throws(() => requestSchemas.taskDeletion({ id: 'not-an-id' }), ValidationError);

    const ownerState = await storage.loadState(ownerId);
    assert.equal(ownerState.wallets.some(wallet => wallet.label === walletLabel), true);
    assert.equal(ownerState.tasks.some(task => task.id === taskId), true);
    await storage.deleteTask(ownerId, taskId);
    await storage.deleteWallet(ownerId, walletLabel);
  } finally {
    await storage.close();
  }
});

integrationTest('link codes expire and are single-use', { timeout: 30_000 }, async () => {
  await migrate();
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  let clock = Date.now();
  const identity = createIdentityService(repository, { now: () => clock });
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const userId = await identity.resolveOrCreate('telegram', `link-owner-${suffix}`);
    const valid = await identity.createLinkCode(userId);
    const linkedUserId = await identity.consumeLinkCode({
      code: valid.code, platform: 'discord', platformUserId: `discord-${suffix}`,
    });
    assert.equal(linkedUserId, userId);
    await assert.rejects(
      identity.consumeLinkCode({ code: valid.code, platform: 'discord', platformUserId: `discord-${suffix}` }),
      LinkCodeError,
    );

    const expiring = await identity.createLinkCode(userId);
    clock = expiring.expiresAt + 1;
    await assert.rejects(
      identity.consumeLinkCode({ code: expiring.code, platform: 'discord', platformUserId: `discord-expired-${suffix}` }),
      LinkCodeError,
    );
  } finally {
    await pool.end();
  }
});
