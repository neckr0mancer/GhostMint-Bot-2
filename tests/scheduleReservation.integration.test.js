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
