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

integrationTest('durable scheduler stores distant jobs, claims once, audits attempts, and supports controls', { timeout:30_000 }, async () => {
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

    await pool.query('UPDATE mint_tasks SET mint_time=NOW()-INTERVAL \'1 second\',next_attempt_at=NOW()-INTERVAL \'1 second\' WHERE user_id=$1 AND id=$2', [userId, distant.id]);
    const claims = await Promise.all([
      schedulerA.claimDue({ workerId:'worker-a', now:Date.now(), leaseMs:60_000, userId }),
      schedulerB.claimDue({ workerId:'worker-b', now:Date.now(), leaseMs:60_000, userId }),
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

    const retryable = makeTask('manual retry', Date.now() - 1_000);
    await storage.saveTask(retryable);
    const failedClaim = await schedulerA.claimDue({ workerId:'worker-c', now:Date.now(), leaseMs:60_000, userId });
    assert.equal(failedClaim.id, retryable.id);
    assert.equal(await schedulerA.fail(failedClaim, { reason:'permanent validation failure', transient:false }), 'failed');
    assert.equal((await schedulerA.retry(userId, retryable.id, Date.now())).status, 'retry');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await storage.close();
  }
});
