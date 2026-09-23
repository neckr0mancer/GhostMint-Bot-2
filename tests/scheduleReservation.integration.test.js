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
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createIdentityService}=require('../src/identity/identityService');
const {createKeyEncryption}=require('../src/security/keyEncryption');

const integrationTest=CONFIG.databaseUrl&&CONFIG.databaseUrlUnpooled?test:test.skip;

integrationTest('two concurrent same-stage reservations have exactly one winner and paused tasks keep the slot',{timeout:120_000},async()=>{
  await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:4});
  const storageA=createPostgresStorage(pool);const storageB=createPostgresStorage(pool);
  const scheduler=createSchedulerRepository(pool);
  const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`reservation-${process.pid}-${Date.now()}`);
  const walletLabel=`reservation-${Date.now()}`;
  const walletAddress='0x0000000000000000000000000000000000000061';
  const contract='0x0000000000000000000000000000000000000062';
  const crypto=createKeyEncryption({activeVersion:CONFIG.encryptionKeyVersion,keys:CONFIG.encryptionKeys});
  await storageA.addWallet({userId,label:walletLabel,address:walletAddress,chain:'ethereum',
    keyEnvelope:crypto.encrypt(`0x${'61'.repeat(32)}`),minted:0,addedAt:Date.now()});
  const mintTime=Date.now()+86_400_000;
  const makeTask=name=>({userId,id:randomUUID(),name,walletLabel,walletAddress,contract,fn:'mint',qty:1,
    price:0,gas:null,chain:'ethereum',mintTime,status:'scheduled',createdAt:Date.now(),nextAttemptAt:mintTime,
    maxAttempts:3,stageUuid:'public-1',stageLabel:'Public',stageType:'public_sale',
    reservationStageKey:'uuid:public-1',eligibilityMode:'specific_stage'});
  try{
    const [left,right]=await Promise.all([
      storageA.createReservedTask(makeTask('left')),storageB.createReservedTask(makeTask('right')),
    ]);
    const results=[left,right];
    assert.equal(results.filter(result=>result.created).length,1);
    assert.equal(results.filter(result=>!result.created).length,1);
    const winner=results.find(result=>result.created).task;
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM mint_tasks
      WHERE user_id=$1 AND reservation_stage_key='uuid:public-1'`,[userId])).rows[0].count,1);
    assert.equal((await scheduler.pause(userId,winner.id)).status,'paused');
    assert.equal((await storageB.createReservedTask(makeTask('while-paused'))).created,false,
      'paused schedules still reserve the stage');
    assert.equal((await scheduler.cancel(userId,winner.id)).status,'cancelled');
    assert.equal((await storageB.createReservedTask(makeTask('after-cancel'))).created,true,
      'terminal cancellation releases the stage');
  }finally{
    await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await storageA.close();
  }
});

integrationTest('phase advancement uses the same envelope lock and rolls back an over-cap move',
  {timeout:120_000},async()=>{
  await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:4});
  const storage=createPostgresStorage(pool);
  const scheduler=createSchedulerRepository(pool);
  const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`phase-envelope-${process.pid}-${Date.now()}`);
  const walletLabel=`phase-envelope-${Date.now()}`;
  const walletAddress='0x0000000000000000000000000000000000000063';
  const contract='0x0000000000000000000000000000000000000064';
  const crypto=createKeyEncryption({activeVersion:CONFIG.encryptionKeyVersion,keys:CONFIG.encryptionKeys});
  await storage.addWallet({userId,label:walletLabel,address:walletAddress,chain:'ethereum',
    keyEnvelope:crypto.encrypt(`0x${'63'.repeat(32)}`),minted:0,addedAt:Date.now()});
  const baseTime=Date.now()+86_400_000;
  const makeTask=({name,stageUuid,mintTime,qty,scope='unknown',maximum=null,minted=null})=>({
    userId,id:randomUUID(),name,walletLabel,walletAddress,contract,fn:'mint',qty,price:0,gas:null,
    chain:'ethereum',mintTime,status:'scheduled',createdAt:Date.now(),nextAttemptAt:mintTime,
    maxAttempts:3,stageUuid,stageLabel:name,stageType:'public_sale',
    reservationStageKey:`uuid:${stageUuid}`,eligibilityMode:'specific_stage',
    allowanceScope:scope,allowanceMaxPerWallet:maximum,allowanceMintedSnapshot:minted,
    allowanceSource:scope==='unknown'?null:'integration:proven-cumulative',
    allowanceVerifiedAt:Date.now(),allowanceStageStartAt:mintTime,
  });
  try {
    const boundary=(await storage.createReservedTask(makeTask({name:'Public boundary',
      stageUuid:'public-boundary',mintTime:baseTime+7_200_000,qty:7,
      scope:'contract_cumulative',maximum:'10',minted:'2'}))).task;
    const moving=(await storage.createReservedTask(makeTask({name:'Later phase',
      stageUuid:'later-phase',mintTime:baseTime+10_800_000,qty:2,minted:'2'}))).task;
    const claimed=await scheduler.claimSpecific({workerId:'phase-envelope-test',userId,
      taskId:moving.id,now:moving.mintTime,leaseMs:60_000});
    assert.ok(claimed,'the later phase should be claimed through the durable scheduler path');
    await assert.rejects(scheduler.deferForPhase(claimed,{
      retryAt:baseTime+3_600_000,mintTime:baseTime+3_600_000,
      stageUuid:'earlier-phase',stageLabel:'Earlier phase',stageType:'allowlist',
      allowanceEvidence:{allowanceScope:'unknown',allowanceMintedSnapshot:'2',
        allowanceSource:'seadrop:getMintStats',allowanceVerifiedAt:Date.now(),
        allowanceStageStartAt:baseTime+3_600_000},reason:'integration phase move',
    }),error=>error.code==='SCHEDULE_ALLOWANCE_EXCEEDED');
    const unchanged=(await pool.query(`SELECT status,reservation_stage_key,stage_uuid
      FROM mint_tasks WHERE user_id=$1 AND id=$2`,[userId,moving.id])).rows[0];
    assert.deepEqual(unchanged,{status:'claimed',reservation_stage_key:'uuid:later-phase',
      stage_uuid:'later-phase'});
    assert.ok(boundary.id);
  } finally {
    await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await storage.close();
  }
});
