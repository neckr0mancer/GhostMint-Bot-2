const assert=require('node:assert/strict');
const path=require('node:path');
const {createIdentityService}=require('../src/identity/identityService');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createDashboardAuthService}=require('../src/dashboard/authService');
const {createDashboardSessionRepository}=require('../src/dashboard/sessionRepository');
const {createBotCommandService}=require('../src/commands/botCommandService');
const {createTestDatabasePool,integrationTest,runTestMigrations}=require('./helpers/disposableDatabase');
const root=path.join(__dirname,'..');
integrationTest('dashboard consumes the existing link code and persists revocable sessions',{timeout:120_000},async()=>{await runTestMigrations({migrationsDirectory:path.join(root,'migrations')});const pool=await createTestDatabasePool({max:2});
  try{const identityRepository=createPostgresIdentityRepository(pool);const identity=createIdentityService(identityRepository);const userId=await identity.resolveOrCreate('telegram',`dashboard-${Date.now()}`);const link=await identity.createLinkCode(userId);const auth=createDashboardAuthService({identity,repository:createDashboardSessionRepository(pool)});const session=await auth.login(link.code);assert.equal(session.userId,userId);assert.equal((await auth.authenticate(`ghostmint_session=${session.token}`)).userId,userId);await auth.revoke({sessionId:session.sessionId});assert.equal(await auth.authenticate(`ghostmint_session=${session.token}`),null);await assert.rejects(auth.login(link.code),/invalid, expired, or already used/);}finally{await pool.end();}});

integrationTest('a link code generated through the shared bot command service can be consumed by a second platform to join the same account',{timeout:120_000},async()=>{
  await runTestMigrations({migrationsDirectory:path.join(root,'migrations')});
  const pool=await createTestDatabasePool({max:2});
  let userId;
  try{
    const identityRepository=createPostgresIdentityRepository(pool);
    const identity=createIdentityService(identityRepository);
    const suffix=`${process.pid}-${Date.now()}`;
    userId=await identity.resolveOrCreate('telegram',`link-dash-${suffix}`);
    const commands=createBotCommandService({identity});
    const link=await commands.linkCode(userId);
    const mergedUserId=await identity.consumeLinkCode({code:link.code,platform:'discord',platformUserId:`discord-dash-${suffix}`});
    assert.equal(mergedUserId,userId);
    const accounts=await identityRepository.listLinkedAccounts(userId);
    assert.deepEqual(accounts.map(account=>account.platform).sort(),['discord','telegram']);
  } finally {
    if(userId)await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
    await pool.end();
  }
});
