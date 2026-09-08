const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Interface, parseEther, parseUnits } = require('ethers');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createSniperRepository } = require('../src/sniper/sniperRepository');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;
const MINT_DATA=new Interface(['function mint(uint256)']).encodeFunctionData('mint',[1]);

integrationTest('source transaction deduplication survives a repository restart', { timeout:120_000 }, async () => {
  await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations') });
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:2});
  const storage=createPostgresStorage(pool);
  const identityRepository=createPostgresIdentityRepository(pool);
  const identity=createIdentityService(identityRepository);
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

    const pending={...sniper,id:randomUUID(),label:'pending replacement dedup',observationMode:'pending'};
    await storage.saveSniper(pending);
    const pendingTx={...tx,hash:`0x${'56'.repeat(32)}`,blockNumber:null,blockHash:null,
      from:sniper.targetAddress,nonce:17,data:MINT_DATA,value:parseEther('0.01'),
      gasPrice:parseUnits('2','gwei'),gasLimit:100_000n};
    assert.ok(await first.detect(pending,pendingTx));
    const replacementHash=`0x${'78'.repeat(32)}`;
    const replacement=await createSniperRepository(pool).detect(pending,{...pendingTx,hash:replacementHash});
    assert.equal(replacement.sourceCurrentHash,replacementHash,
      'a replacement updates the same durable source action instead of creating a second event');
    const pendingRows=await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM sniper_seen_transactions
      WHERE user_id=$1 AND sniper_id=$2`,[userId,pending.id]);
    assert.equal(pendingRows.rows[0].count,1);
    const readyPending=await createSniperRepository(pool).listReady('ethereum',101,[pending]);
    assert.equal(readyPending.length,1,'pending source payload remains recoverable after restart');

    assert.equal(await identity.getSniperObservationDefault(userId),'confirmed');
    await identity.setSniperObservationDefault(userId,'pending');
    const restartedIdentity=createIdentityService(createPostgresIdentityRepository(pool));
    assert.equal(await restartedIdentity.getSniperObservationDefault(userId),'pending');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await storage.close();
  }
});

integrationTest('sniper claim serializes daily-cap and cooldown reservations across workers', { timeout:120_000 }, async () => {
  await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations') });
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:3});
  const storage=createPostgresStorage(pool);const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`sniper-claim-${process.pid}-${Date.now()}`);
  const sniper={userId,id:randomUUID(),label:'atomic claim',targetAddress:'0x0000000000000000000000000000000000000011',
    chain:'ethereum',walletLabel:'Primary',valueMode:'copy',fixedValueETH:0,maxValueETH:0.1,gasBoostPercent:0,
    maxGasGwei:100,dailySpendingCapETH:0.015,cooldownMs:60_000,maxAttempts:3,contractAllowlist:[],contractDenylist:[],
    sourceConfirmations:1,observationMode:'pending',active:true,hits:0,fails:0,createdAt:Date.now()};
  try{
    await storage.saveSniper(sniper);const repository=createSniperRepository(pool);
    const base={to:'0x0000000000000000000000000000000000000022',from:sniper.targetAddress,
      data:MINT_DATA,value:parseEther('0.01'),gasPrice:parseUnits('2','gwei'),gasLimit:100_000n};
    const first=await repository.detect(sniper,{...base,hash:`0x${'21'.repeat(32)}`,nonce:1});
    const second=await repository.detect(sniper,{...base,hash:`0x${'22'.repeat(32)}`,nonce:2});
    const options={maxAttempts:3,nowMs:Date.now(),cooldownMs:sniper.cooldownMs,
      dailyCapWei:parseEther(String(sniper.dailySpendingCapETH)),copiedValueWei:base.value,
      reservedNetworkCostWei:base.gasPrice*base.gasLimit};
    const results=await Promise.all([repository.claim(first,options),repository.claim(second,options)]);
    assert.equal(results.filter(result=>result.event).length,1);
    assert.equal(results.filter(result=>result.terminal&&/cooldown|daily/.test(result.reason)).length,1);
    assert.equal(await repository.dailySpendWei(userId,sniper.id,Date.now()-86_400_000),
      base.value+options.reservedNetworkCostWei,
      'the rolling cap reserves copied value plus network cost before an intent is attached');
  }finally{
    await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await storage.close();
  }
});
