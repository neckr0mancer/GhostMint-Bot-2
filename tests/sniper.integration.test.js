const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createSniperRepository } = require('../src/sniper/sniperRepository');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('source transaction deduplication survives a repository restart', { timeout:30_000 }, async () => {
  await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations') });
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:2});
  const storage=createPostgresStorage(pool);
  const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`sniper-${process.pid}-${Date.now()}`);
  const sniper={ userId,id:randomUUID(),label:'restart dedup',targetAddress:'0x0000000000000000000000000000000000000011',
    chain:'ethereum',walletLabel:'Primary',valueMode:'copy',fixedValueETH:0,maxValueETH:0.1,gasBoostPercent:20,
    maxGasGwei:100,dailySpendingCapETH:0.25,cooldownMs:0,maxAttempts:3,contractAllowlist:[],contractDenylist:[],
    sourceConfirmations:2,active:true,hits:0,fails:0,createdAt:Date.now() };
  const tx={hash:`0x${'12'.repeat(32)}`,to:'0x0000000000000000000000000000000000000022',blockNumber:100,blockHash:`0x${'34'.repeat(32)}`};
  try {
    await storage.saveSniper(sniper);
    const first=createSniperRepository(pool);
    assert.ok(await first.detect(sniper,tx));
    const restarted=createSniperRepository(pool);
    assert.equal(await restarted.detect(sniper,tx),null);
    const persisted=await restarted.get(userId,sniper.id,tx.hash);
    assert.equal(persisted.state,'detected');
    const ready=await restarted.listReady('ethereum',101,[sniper]);
    assert.deepEqual(ready.map(event=>event.txHash),[tx.hash]);
    const transitions=await pool.query(`SELECT state FROM sniper_event_transitions
      WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3`,[userId,sniper.id,tx.hash]);
    assert.deepEqual(transitions.rows.map(row=>row.state),['detected']);
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await storage.close();
  }
});
