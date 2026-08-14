const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createSocialWatchRepository } = require('../src/social/socialWatchRepository');
const { createSocialWatchService } = require('../src/social/socialWatchService');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('social rules and deduplicated trigger events persist in PostgreSQL', { timeout:30_000 }, async () => {
  await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations') });
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:2});
  const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`social-${process.pid}-${Date.now()}`);
  const repository=createSocialWatchRepository(pool); const emitted=[];
  const service=createSocialWatchService({repository,adapters:new Map([['scraper',{poll:async()=>({items:[{
    id:'message-1',text:'contract 0x000000000000000000000000000000000000dEaD',platform:'discord',publishedAt:Date.now(),
  }]})}]]),emitTrigger:async event=>emitted.push(event)});
  try {
    const rule=await service.create(userId,{name:'persistent scraper',type:'discord_channel',method:'scraper',
      config:{channelId:'123456789012345678',keywords:[],sourceUrl:'https://example.com/feed'}});
    await service.processRule(rule);
    await service.processRule(rule);
    assert.equal((await repository.list(userId)).length,1);
    assert.equal(emitted.length,1);
    const persisted=await pool.query('SELECT trigger_source,address FROM social_trigger_events WHERE user_id=$1',[userId]);
    assert.deepEqual(persisted.rows,[{trigger_source:'social-triggered',address:'0x000000000000000000000000000000000000dEaD'}]);
    await repository.recordUsage({userId,ruleId:rule.id,ruleName:rule.name,method:'scraper',requestType:'read',
      providerCostUsd:null,providerCredits:null,succeeded:true,requestedAt:Date.now()});
    const usage=await repository.usageSince(Date.now()-60_000);
    assert.equal(usage[0].requests,1);
    assert.equal(usage[0].method,'scraper');
  } finally { await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{}); await pool.end(); }
});

integrationTest('Milestone 10b-2: a Farcaster watch rule persists and its trigger events carry the farcaster platform', { timeout:30_000 }, async () => {
  await runMigrations({ connectionString:CONFIG.databaseUrlUnpooled,
    migrationsDirectory:path.join(CONFIG.projectRoot,'migrations') });
  const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:2});
  const identity=createIdentityService(createPostgresIdentityRepository(pool));
  const userId=await identity.resolveOrCreate('telegram',`social-farcaster-${process.pid}-${Date.now()}`);
  const repository=createSocialWatchRepository(pool); const emitted=[];
  const service=createSocialWatchService({repository,adapters:new Map([['scraper',{poll:async()=>({items:[{
    id:'cast-1',text:'contract 0x000000000000000000000000000000000000dEaD',platform:'farcaster',publishedAt:Date.now(),
  }]})}]]),emitTrigger:async event=>emitted.push(event)});
  try {
    const rule=await service.create(userId,{name:'persistent farcaster',type:'farcaster_account',method:'scraper',
      config:{handle:'ghostmint',keywords:[],sourceUrl:'https://example.com/casts'}});
    await service.processRule(rule);
    assert.equal((await repository.list(userId))[0].type,'farcaster_account');
    assert.equal(emitted.length,1);
    const persisted=await pool.query('SELECT platform FROM social_trigger_events WHERE user_id=$1',[userId]);
    assert.deepEqual(persisted.rows,[{platform:'farcaster'}]);
  } finally { await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{}); await pool.end(); }
});
