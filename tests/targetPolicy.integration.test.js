const assert=require('node:assert/strict');
const path=require('node:path');
const test=require('node:test');
const {CONFIG}=require('../src/config');
const {runMigrations}=require('../src/db/migrate');
const {createDatabasePool}=require('../src/db/pool');
const {createIdentityService}=require('../src/identity/identityService');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createTargetPolicyRepository}=require('../src/triggers/targetPolicyRepository');

const integrationTest=CONFIG.databaseUrl&&CONFIG.databaseUrlUnpooled?test:test.skip;
integrationTest('target acknowledgement, durable confirmation request, and execution audit persist', {timeout:30_000},async()=>{
 await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
 const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:2});
 const identity=createIdentityService(createPostgresIdentityRepository(pool));
 const userId=await identity.resolveOrCreate('telegram',`policy-${process.pid}-${Date.now()}`);
 const repository=createTargetPolicyRepository(pool);
 const targetId='123e4567-e89b-42d3-a456-426614174000';
 try{
  const policy=await repository.save({userId,targetType:'social_rule',targetId,blockchainTrigger:'auto',socialTrigger:'auto',humanVerification:'bypassed',dontAskAgain:true,walletLabel:'Primary',mintPresetName:'Drop'});
  assert.equal((await repository.get(userId,'social_rule',targetId)).dontAskAgain,true);
  const request=await repository.createRequest({userId,targetType:'social_rule',targetId,triggerSource:'social-triggered',sourceEventId:'source-1',preview:{contractAddress:'0x0000000000000000000000000000000000000001'},executionPayload:{id:'source-1'},expiresAt:Date.now()+60_000});
  assert.equal((await repository.claimRequest(userId,request.id,Date.now())).status,'executing');
  await repository.addAudit({userId,targetType:'social_rule',targetId,triggerSource:'social-triggered',sourceEventId:'source-1',verificationState:policy.humanVerification,dontAskAgain:true,confirmationShown:false,outcome:'confirmed'});
  const audit=await repository.listAudit(userId);assert.equal(audit[0].verification_state,'bypassed');assert.equal(audit[0].dont_ask_again_active,true);
 }finally{await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});await pool.end();}
});
