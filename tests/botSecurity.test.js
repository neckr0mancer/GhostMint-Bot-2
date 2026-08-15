const assert=require('node:assert/strict');
const test=require('node:test');
const {BotContextError,RateLimitError,createCommandRateLimiter,escapeDiscord,escapeTelegram,
  requireTextConfirmation,verifyDiscordContext,verifyTelegramContext}=require('../src/security/botSecurity');
const {createTriggerExecutionService}=require('../src/triggers/triggerExecutionService');
const {createGracefulShutdown}=require('../src/security/gracefulShutdown');

test('platform context verification rejects spoofable or unauthorized origins',()=>{
 assert.throws(()=>verifyTelegramContext({from:{id:1},chat:{id:-2,type:'group'}}),BotContextError);
 assert.deepEqual(verifyTelegramContext({from:{id:1},chat:{id:1,type:'private'}}),{platformUserId:'1',contextId:'1'});
 assert.throws(()=>verifyDiscordContext({user:{id:'u'},guildId:'wrong',channelId:'c'},'allowed'),BotContextError);
 assert.equal(verifyDiscordContext({user:{id:'u'},guildId:'allowed',channelId:'c'},'allowed').contextId,'allowed:c');
});

test('destructive confirmation and rate limiting are shared platform controls',()=>{
 assert.throws(()=>requireTextConfirmation('confirm'),BotContextError);assert.doesNotThrow(()=>requireTextConfirmation('CONFIRM'));
 let now=1000;const limiter=createCommandRateLimiter({now:()=>now,limit:2,windowMs:100});
 limiter.check('telegram','u','mint');limiter.check('telegram','u','mint');
 assert.throws(()=>limiter.check('telegram','u','mint'),RateLimitError);
 assert.doesNotThrow(()=>limiter.check('discord','u','mint'));
 now=1200;assert.doesNotThrow(()=>limiter.check('telegram','u','mint'));
});

// Regression test: every distinct platform:userId:command key created a bucket that was never
// removed, even once every timestamp in it aged out of the rate-limit window -- checking a key only
// ever refreshes THAT key, so a command a user tries once and never again leaves its bucket sitting
// in memory forever. Over a long-running bot's lifetime this grows without bound. sweepThreshold
// forces the prune path here (its real default is 10,000, too high to exercise directly in a test).
test('rate limiter buckets that have fully aged out are pruned instead of growing forever', () => {
  let now = 0;
  const limiter = createCommandRateLimiter({ now: () => now, limit: 2, windowMs: 100, sweepThreshold: 3 });
  limiter.check('telegram', 'stale-user-1', 'mint');
  limiter.check('telegram', 'stale-user-2', 'mint');
  now = 1000; // well past windowMs=100, so both buckets above are now fully stale
  limiter.check('telegram', 'fresh-user', 'mint'); // brings buckets.size to 3 == sweepThreshold
  // check() reads buckets.size before adding its own key, so the sweep fires on this next call (the
  // first one made once size has already reached the threshold), not the call that reached it.
  assert.doesNotThrow(() => { limiter.check('telegram', 'stale-user-1', 'mint'); limiter.check('telegram', 'stale-user-1', 'mint'); },
    'a swept-out bucket must behave exactly like a fresh one, not carry over stale state');
  assert.throws(() => limiter.check('telegram', 'stale-user-1', 'mint'), RateLimitError,
    'pruning must not weaken the limit -- the two fresh checks just above still count toward it');
});

test('user content escaping neutralizes Telegram, Discord, and mention formatting',()=>{
 assert.equal(escapeTelegram('*bold*_[x]'),'\\*bold\\*\\_\\[x\\]');
 const discord=escapeDiscord('**boom** @everyone `code`');
 assert.match(discord,/\\\*\\\*boom/);assert.doesNotMatch(discord,/@everyone/);assert.match(discord,/@\u200beveryone/);
});

test('failed trigger notification leaves the pending confirmation record intact',async()=>{
 const requests=[];let executions=0;
 const repository={async createRequest(value){const saved={...value,id:'request-1'};requests.push(saved);return saved;},async addAudit(){}};
 const service=createTriggerExecutionService({repository,policyService:{get:async()=>({socialTrigger:'manual',humanVerification:'on',dontAskAgain:false})},
  prepareExecution:async()=>({preview:{method:'mint()'},executionPayload:{}}),execute:async()=>{executions+=1;},notify:async()=>{throw new Error('delivery failed');}});
 const result=await service.handle({id:'event',userId:'u',targetType:'social_rule',targetId:'t',triggerSource:'social-triggered'});
 assert.equal(result.action,'confirmation_required');assert.equal(requests.length,1);assert.equal(executions,0);
});

test('graceful shutdown stops both bots, workers, watchers, HTTP, and database once',async()=>{
 const calls=[];const http={close(callback){calls.push('http');callback();}};
 const shutdown=createGracefulShutdown({getHttpServer:()=>http,telegramBot:{stopPolling:async()=>calls.push('telegram')},
  discordBot:{stop:async()=>calls.push('discord')},schedulerWorker:{stop:()=>calls.push('scheduler')},
  socialWatchWorker:{stop:()=>calls.push('social')},stopWatchers:()=>calls.push('watchers'),pool:{end:async()=>calls.push('pool')}});
 await Promise.all([shutdown('SIGTERM'),shutdown('SIGINT')]);
 assert.deepEqual(calls.sort(),['discord','http','pool','scheduler','social','telegram','watchers'].sort());
});
