const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createSchedulerRepository } = require('../src/scheduler/schedulerRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { requestSchemas } = require('../src/validation/domain');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('durable scheduler stores distant jobs, claims once, audits attempts, and supports controls', { timeout:120_000 }, async () => {
  const migration = await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot, 'migrations') });
  assert.equal(migration.connection, 'unpooled');

  const pool = createDatabasePool({ connectionString:CONFIG.databaseUrl, max:4 });
  const storage = createPostgresStorage(pool);
  const schedulerA = createSchedulerRepository(pool);
  const schedulerB = createSchedulerRepository(pool);
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const userId = await identity.resolveOrCreate('telegram', `scheduler-${process.pid}-${Date.now()}`);
  const label = `scheduler-${Date.now()}`;
  const crypto = createKeyEncryption({ activeVersion:CONFIG.encryptionKeyVersion, keys:CONFIG.encryptionKeys });
  await storage.addWallet({ userId, label, address:'0x0000000000000000000000000000000000000011', chain:'ethereum',
    keyEnvelope:crypto.encrypt(`0x${'45'.repeat(32)}`), minted:0, addedAt:Date.now() });

  const makeTask = (name, mintTime) => ({ userId, id:randomUUID(), name, walletLabel:label,
    contract:'0x0000000000000000000000000000000000000022', fn:'mint', qty:1, price:0, gas:null,
    chain:'ethereum', mintTime, status:'scheduled', createdAt:Date.now() });
  try {
    const distantTime = Date.now() + 180 * 24 * 60 * 60 * 1000;
    const validated = requestSchemas.taskCreate(makeTask('distant', distantTime),
      { supportedChains:CONFIG.supportedChains, now:Date.now() });
    const distant = { ...makeTask('distant', distantTime), ...validated };
    await storage.saveTask(distant);
    assert.equal((await schedulerA.listForUser(userId)).find(item => item.id === distant.id).mintTime, distantTime);
    assert.equal(await schedulerA.claimDue({ workerId:'early-worker', now:Date.now(), leaseMs:60_000, userId }), null,
      'a distant task must not fire immediately');

    const dueTestTime=distantTime+1_000;
    const claims = await Promise.all([
      schedulerA.claimDue({ workerId:'worker-a', now:dueTestTime, leaseMs:60_000, userId }),
      schedulerB.claimDue({ workerId:'worker-b', now:dueTestTime, leaseMs:60_000, userId }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'SKIP LOCKED claim must have exactly one winner');
    const attempts = await pool.query('SELECT * FROM mint_task_attempts WHERE user_id=$1 AND task_id=$2', [userId, distant.id]);
    assert.equal(attempts.rowCount, 1);
    assert.equal(attempts.rows[0].outcome, 'running');

    const controllable = makeTask('controls', Date.now() + 86_400_000);
    await storage.saveTask(controllable);
    assert.equal((await schedulerA.pause(userId, controllable.id)).status, 'paused');
    assert.equal((await schedulerA.resume(userId, controllable.id, Date.now())).status, 'scheduled');
    assert.equal((await schedulerA.cancel(userId, controllable.id)).status, 'cancelled');

    const retryable = makeTask('manual retry', dueTestTime + 1_000);
    await storage.saveTask(retryable);
    const failedClaim = await schedulerA.claimDue({ workerId:'worker-c', now:dueTestTime+2_000, leaseMs:60_000, userId });
    assert.equal(failedClaim.id, retryable.id);
    assert.equal(await schedulerA.fail(failedClaim, { reason:'permanent validation failure', transient:false }), 'failed');
    assert.equal((await schedulerA.retry(userId, retryable.id, Date.now())).status, 'retry');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await storage.close();
  }
});

integrationTest('listPageForUser search filters at the database level, not just the currently-loaded page', { timeout:120_000 }, async () => {
  const migration = await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot, 'migrations') });
  assert.equal(migration.connection, 'unpooled');

  const pool = createDatabasePool({ connectionString:CONFIG.databaseUrl, max:2 });
  const storage = createPostgresStorage(pool);
  const scheduler = createSchedulerRepository(pool);
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const userId = await identity.resolveOrCreate('telegram', `search-tasks-${process.pid}-${Date.now()}`);
  const label = `search-wallet-${Date.now()}`;
  const crypto = createKeyEncryption({ activeVersion:CONFIG.encryptionKeyVersion, keys:CONFIG.encryptionKeys });
  await storage.addWallet({ userId, label, address:'0x0000000000000000000000000000000000000033', chain:'ethereum',
    keyEnvelope:crypto.encrypt(`0x${'46'.repeat(32)}`), minted:0, addedAt:Date.now() });
  const makeTask = (name, mintTime) => ({ userId, id:randomUUID(), name, walletLabel:label,
    contract:'0x0000000000000000000000000000000000000044', fn:'mint', qty:1, price:0, gas:null,
    chain:'ethereum', mintTime, status:'scheduled', createdAt:Date.now() });
  try {
    const base = Date.now() + 24 * 60 * 60 * 1000;
    // Eight non-matching tasks sort ahead of the one matching task under the query's own
    // ORDER BY (mint_time,id) -- a bug that filtered only the already-fetched page (limit:5)
    // would never see the match, since it sorts into what would be page two.
    for (let i = 0; i < 8; i++) {
      const validated = requestSchemas.taskCreate(makeTask(`unrelated-${i}`, base + i * 1000),
        { supportedChains:CONFIG.supportedChains, now:Date.now() });
      await storage.saveTask({ ...makeTask(`unrelated-${i}`, base + i * 1000), ...validated });
    }
    const matchingRaw = makeTask('findme-special-task', base + 8_000);
    const matchingValidated = requestSchemas.taskCreate(matchingRaw, { supportedChains:CONFIG.supportedChains, now:Date.now() });
    await storage.saveTask({ ...matchingRaw, ...matchingValidated });

    const page = await scheduler.listPageForUser(userId, { limit:5, offset:0, search:'findme' });
    assert.equal(page.total, 1, 'total must reflect only the matching row, not the unfiltered first page');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].name, 'findme-special-task');

    const unfiltered = await scheduler.listPageForUser(userId, { limit:5, offset:0 });
    assert.equal(unfiltered.total, 9, 'without a search term every task for the user is still counted');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await storage.close();
  }
});

// Pre-arm fire-time correction (scheduledValidity / INNOV-001): the contract's real opening
// differs from the advertised time, so the pre-arm moves next_attempt_at BEFORE T arrives --
// the first attempt lands valid with zero failed tries. Only a still-'scheduled' row moves:
// claimed/retried/paused rows are owned by other paths, and mint_time (what the user sees)
// is deliberately kept while only the internal fire moment moves.
integrationTest('moveFireTime moves a scheduled task to the real opening and refuses non-scheduled rows', { timeout:120_000 }, async () => {
  const migration = await runMigrations({ connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
  assert.equal(migration.connection, 'unpooled');

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const storage = createPostgresStorage(pool);
  const scheduler = createSchedulerRepository(pool);
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const userId = await identity.resolveOrCreate('telegram', `movefire-${process.pid}-${Date.now()}`);
  const label = `movefire-${Date.now()}`;
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  await storage.addWallet({ userId, label, address: '0x0000000000000000000000000000000000000022', chain: 'ethereum',
    keyEnvelope: crypto.encrypt(`0x${'55'.repeat(32)}`), addedAt: Date.now() });
  try {
    const fireAt = Date.now() + 5000;
    const validated = requestSchemas.taskCreate({ userId, id: randomUUID(), name: 'move-me', walletLabel: label,
      contract: '0x0000000000000000000000000000000000000044', fn: 'mint', qty: 1, price: 0, gas: null,
      chain: 'ethereum', mintTime: fireAt, status: 'scheduled', createdAt: Date.now() },
      { supportedChains: CONFIG.supportedChains, now: Date.now() });
    const task = { userId, id: validated.id, name: 'move-me', walletLabel: label,
      contract: '0x0000000000000000000000000000000000000044', fn: 'mint', qty: 1, price: 0, gas: null,
      chain: 'ethereum', mintTime: fireAt, status: 'scheduled', createdAt: Date.now(),
      nextAttemptAt: fireAt, maxAttempts: 3, idempotencyKey: validated.idempotencyKey,
      viaOpenSea: false, stageType: null };
    await storage.saveTask(task);

    const newFire = Date.now() + 9000;
    const moved = await scheduler.moveFireTime(userId, task.id, newFire);
    assert.ok(moved, 'a scheduled task moves');
    assert.equal(moved.nextAttemptAt, newFire, 'next_attempt_at is the real opening');
    assert.equal(moved.mintTime, fireAt, 'the user-visible mint_time is deliberately kept');
    assert.equal(moved.status, 'scheduled');

    // A claimed row is owned by the fire path -- moveFireTime must not move it behind the worker's back.
    await scheduler.claimDue({ workerId: 'movefire-worker', now: newFire + 1, leaseMs: 60_000, userId });
    const refused = await scheduler.moveFireTime(userId, task.id, Date.now() + 60_000);
    assert.equal(refused, null, 'a claimed task must not be moved');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await storage.close();
  }
});
