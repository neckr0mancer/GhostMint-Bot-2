const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const dotenv=require('dotenv');
const {createDatabasePool}=require('../src/db/pool');
const {runMigrations}=require('../src/db/migrate');
const {createIdentityService}=require('../src/identity/identityService');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createDashboardAuthService}=require('../src/dashboard/authService');
const {createDashboardSessionRepository}=require('../src/dashboard/sessionRepository');
const {createBotCommandService}=require('../src/commands/botCommandService');
const root=path.join(__dirname,'..');const local=path.join(root,'.env');const env=fs.existsSync(local)?dotenv.parse(fs.readFileSync(local)):{};
const integration=env.DATABASE_URL&&env.DATABASE_URL_UNPOOLED?test:test.skip;
integration('dashboard consumes the existing link code and persists revocable sessions',{timeout:30_000},async()=>{await runMigrations({connectionString:env.DATABASE_URL_UNPOOLED,migrationsDirectory:path.join(root,'migrations')});const pool=createDatabasePool({connectionString:env.DATABASE_URL,max:2});
  try{const identityRepository=createPostgresIdentityRepository(pool);const identity=createIdentityService(identityRepository);const userId=await identity.resolveOrCreate('telegram',`dashboard-${Date.now()}`);const link=await identity.createLinkCode(userId);const auth=createDashboardAuthService({identity,repository:createDashboardSessionRepository(pool)});const session=await auth.login(link.code);assert.equal(session.userId,userId);assert.equal((await auth.authenticate(`ghostmint_session=${session.token}`)).userId,userId);await auth.revoke({sessionId:session.sessionId});assert.equal(await auth.authenticate(`ghostmint_session=${session.token}`),null);await assert.rejects(auth.login(link.code),/invalid, expired, or already used/);}finally{await pool.end();}});

integration('a link code generated through the shared bot command service can be consumed by a second platform to join the same account',{timeout:30_000},async()=>{
  await runMigrations({connectionString:env.DATABASE_URL_UNPOOLED,migrationsDirectory:path.join(root,'migrations')});
  const pool=createDatabasePool({connectionString:env.DATABASE_URL,max:2});
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
