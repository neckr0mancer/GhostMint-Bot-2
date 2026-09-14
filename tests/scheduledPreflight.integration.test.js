'use strict';

const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CONFIG}=require('../src/config');
const {runMigrations}=require('../src/db/migrate');
const {createDatabasePool}=require('../src/db/pool');
const {createPostgresStorage}=require('../src/storage/postgresStorage');
const {createSchedulerRepository}=require('../src/scheduler/schedulerRepository');
const {createScheduledPreflightRepository}=require('../src/scheduler/scheduledPreflightRepository');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createIdentityService}=require('../src/identity/identityService');
const {createKeyEncryption}=require('../src/security/keyEncryption');

const integrationTest=CONFIG.databaseUrl&&CONFIG.databaseUrlUnpooled?test:test.skip;

integrationTest('durable schedule checks claim once, recover an expired lease, and re-arm by generation',
  {timeout:120_000},async()=>{
    await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,
      migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
    const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:4});
    const storage=createPostgresStorage(pool);
    const scheduler=createSchedulerRepository(pool);
    const left=createScheduledPreflightRepository(pool);
    const right=createScheduledPreflightRepository(pool);
    const identity=createIdentityService(createPostgresIdentityRepository(pool));
    const userId=await identity.resolveOrCreate('telegram',`preflight-${process.pid}-${Date.now()}`);
    const walletLabel=`preflight-${Date.now()}`;
    const walletAddress='0x0000000000000000000000000000000000000062';
    const contract='0x0000000000000000000000000000000000000063';
    const crypto=createKeyEncryption({activeVersion:CONFIG.encryptionKeyVersion,keys:CONFIG.encryptionKeys});
    await storage.addWallet({userId,label:walletLabel,address:walletAddress,chain:'ethereum',
      keyEnvelope:crypto.encrypt(`0x${'62'.repeat(32)}`),minted:0,addedAt:Date.now()});
    const firstTarget=Date.now()+4*60*1000;
    const task={userId,id:randomUUID(),name:'preflight integration',walletLabel,walletAddress,
      contract,fn:'mint',qty:1,price:0,gas:null,chain:'ethereum',mintTime:firstTarget,
      status:'scheduled',createdAt:Date.now(),nextAttemptAt:firstTarget,maxAttempts:3,
      stageUuid:'public-preflight',stageLabel:'Public',stageType:'public_sale',
      reservationStageKey:'uuid:public-preflight',eligibilityMode:'specific_stage'};
    try{
      assert.equal((await storage.createReservedTask(task)).created,true);
      const now=Date.now();
      const [a,b]=await Promise.all([
        left.claimDue({workerId:'left',now,leaseMs:60_000,limit:5,userId,taskId:task.id}),
        right.claimDue({workerId:'right',now,leaseMs:60_000,limit:5,userId,taskId:task.id}),
      ]);
      assert.equal(a.length+b.length,1,'only one worker may claim the due five-minute check');
      const first=(a[0]||b[0]);
      assert.equal(first.check.checkpoint,'five_minute');
      assert.equal((await left.complete(first,{result:'ready',reason:'ready',mintValueWei:0n,
        estimatedGasWei:1n,totalDebitWei:1n,balanceWei:2n,shortfallWei:0n})).completed,true);
      const [notificationA,notificationB]=await Promise.all([
        left.claimNotifications({workerId:'notify-left',now:Date.now(),leaseMs:60_000,limit:5,userId,taskId:task.id}),
        right.claimNotifications({workerId:'notify-right',now:Date.now(),leaseMs:60_000,limit:5,userId,taskId:task.id}),
      ]);
      assert.equal(notificationA.length+notificationB.length,1,
        'only one worker may claim a committed checkpoint notification');
      const notificationClaim=notificationA[0]||notificationB[0];
      await pool.query(`UPDATE mint_task_preflight_checks
        SET notification_lease_expires_at=NOW()-INTERVAL '1 second' WHERE check_id=$1`,
      [notificationClaim.check.checkId]);
      const recoveredNotification=await right.claimNotifications({workerId:'notify-replacement',
        now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(recoveredNotification.length,1);
      const delivered=await right.finishNotification(recoveredNotification[0],{now:Date.now()});
      assert.equal(delivered.notificationState,'delivered');

      const secondTarget=Date.now()+4*60*1000+5_000;
      const moved=await scheduler.moveFireTime(userId,task.id,secondTarget);
      assert.equal(moved.preflightGeneration,2);
      const generations=await pool.query(`SELECT generation,state,checkpoint FROM mint_task_preflight_checks
        WHERE user_id=$1 AND task_id=$2 ORDER BY generation,checkpoint`,[userId,task.id]);
      assert.equal(generations.rows.filter(row=>Number(row.generation)===2).length,2);
      assert.equal(generations.rows.find(row=>Number(row.generation)===1&&row.checkpoint==='thirty_second').state,
        'superseded');

      const crashed=await left.claimDue({workerId:'crashed',now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(crashed.length,1);assert.equal(crashed[0].check.generation,2);
      await pool.query(`UPDATE mint_task_preflight_checks SET lease_expires_at=NOW()-INTERVAL '1 second'
        WHERE check_id=$1`,[crashed[0].check.checkId]);
      const recovered=await right.claimDue({workerId:'replacement',now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(recovered.length,1);assert.equal(recovered[0].check.checkId,crashed[0].check.checkId);
      assert.equal(recovered[0].check.claimedBy,'replacement');
    }finally{
      await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
      await storage.close();
    }
  });
