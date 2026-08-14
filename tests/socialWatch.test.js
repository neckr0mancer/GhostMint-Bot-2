const assert = require('node:assert/strict');
const test = require('node:test');
const { createSocialAdapters } = require('../src/social/adapters');
const { createSocialWatchService, extractContractAddresses } = require('../src/social/socialWatchService');
const { createTriggerPipeline } = require('../src/triggers/triggerPipeline');

const ADDRESS = '0x000000000000000000000000000000000000dEaD';
const ID = '123e4567-e89b-42d3-a456-426614174000';

function memoryRepository() {
  const rules = [];
  const events = new Map();
  return {
    rules, events,
    async create(userId, rule) { const value = { ...rule, id:`${ID.slice(0,-1)}${rules.length}`, userId, cursor:null, consecutiveFailures:0 }; rules.push(value); return value; },
    async get(userId, id) { return rules.find(rule => rule.userId === userId && rule.id === id) || null; },
    async list(userId) { return rules.filter(rule => rule.userId === userId); },
    async update(userId, id, value) { const rule = await this.get(userId, id); if (!rule) return null; Object.assign(rule, value); return rule; },
    async remove(userId, id) { const index = rules.findIndex(rule => rule.userId === userId && rule.id === id); if (index < 0) return false; rules.splice(index,1); return true; },
    async listDue() { return rules.filter(rule => rule.enabled); },
    async markSuccess(rule, value) { rule.cursor=value.cursor; rule.consecutiveFailures=0; },
    async markFailure(rule) { rule.consecutiveFailures += 1; return rule.consecutiveFailures; },
    async createTrigger(event) { if (events.has(event.dedupKey)) return null; const value={...event,id:`event-${events.size}`}; events.set(event.dedupKey,value); return value; },
  };
}

function valid(type, method = 'scraper', index = 0) {
  const base = { name:`rule-${type}-${index}`, type, method, config:{ sourceUrl:'https://source.example/feed' } };
  if (type === 'twitter_account' || type === 'farcaster_account') base.config.handle='ghostmint';
  if (type === 'twitter_keyword' || type === 'discord_keyword' || type === 'farcaster_keyword') base.config.keywords=['mint'];
  if (type === 'discord_channel') base.config.channelId='123456789012345678';
  return base;
}

test('every watch-rule type, including the Milestone 10b-2 Farcaster addition, can be created, edited, disabled, and removed', async () => {
  const repository=memoryRepository();
  const service=createSocialWatchService({repository,adapters:new Map(),emitTrigger:async()=>{}});
  for (const type of ['twitter_account','twitter_keyword','discord_channel','discord_keyword','farcaster_account','farcaster_keyword']) {
    const created=await service.create('user-a',valid(type,'scraper',repository.rules.length));
    const edited=await service.update('user-a',created.id,{name:`edited-${type}`});
    assert.equal(edited.name,`edited-${type}`);
    assert.equal((await service.disable('user-a',created.id)).enabled,false);
    assert.equal(await service.remove('user-a',created.id),created.id);
  }
  assert.equal(repository.rules.length,0);
});

test('detected address emits a tagged event and near-simultaneous cross-rule matches deduplicate', async () => {
  const repository=memoryRepository(); const emitted=[];
  const adapter={poll:async()=>({items:[{id:'post-1',text:`Mint contract ${ADDRESS}`,platform:'twitter',publishedAt:1_000}],cursor:'next'})};
  const service=createSocialWatchService({repository,adapters:new Map([['scraper',adapter]]),emitTrigger:async event=>emitted.push(event),now:()=>1_000});
  const first=await service.create('user-a',valid('twitter_account', 'scraper', 1));
  const second=await service.create('user-a',valid('twitter_keyword', 'scraper', 2));
  await Promise.all([service.processRule(first),service.processRule(second)]);
  assert.equal(emitted.length,1);
  assert.equal(emitted[0].triggerSource,'social-triggered');
  assert.equal(emitted[0].address,ADDRESS);
  assert.equal(extractContractAddresses(`bad 0x123 and ${ADDRESS}`).length,1);
});

test('social and blockchain detections publish through the same trigger pipeline interface', async () => {
  const received=[];
  const pipeline=createTriggerPipeline({handlers:[async event=>received.push(event)]});
  await pipeline.publish({id:'social-1',userId:'user-a',address:ADDRESS,triggerSource:'social-triggered'});
  await pipeline.publish({id:'chain-1',userId:'user-a',address:ADDRESS,triggerSource:'blockchain-triggered'});
  assert.deepEqual(received.map(event=>event.triggerSource),['social-triggered','blockchain-triggered']);
});

test('a failed adapter is isolated and another due rule still emits', async () => {
  const repository=memoryRepository(); const emitted=[];
  const adapters=new Map([
    ['official_api',{poll:async()=>{throw new Error('rate limited');}}],
    ['scraper',{poll:async()=>({items:[{id:'ok',text:ADDRESS,platform:'discord',publishedAt:2_000}]})}],
  ]);
  const service=createSocialWatchService({repository,adapters,emitTrigger:async event=>emitted.push(event),now:()=>2_000});
  await service.create('user-a',{...valid('twitter_account','official_api',1),config:{handle:'x'}});
  await service.create('user-a',valid('discord_channel','scraper',2));
  const results=await service.pollOnce();
  assert.equal(results.every(result=>result.status==='fulfilled'),true);
  assert.equal(emitted.length,1);
  assert.equal(repository.rules[0].consecutiveFailures,1);
});

test('repeated adapter failure notifies the rule owner at the configured threshold', async () => {
  const repository=memoryRepository(); const notifications=[];
  const service=createSocialWatchService({repository,adapters:new Map([['scraper',{poll:async()=>{throw new Error('broken target');}}]]),
    emitTrigger:async()=>{},notifyOwner:async(...args)=>notifications.push(args),failureNotifyThreshold:3});
  const rule=await service.create('user-a',valid('twitter_account','scraper',1));
  await service.processRule(rule); await service.processRule(rule); await service.processRule(rule);
  assert.equal(notifications.length,1);
  assert.equal(notifications[0][0],'user-a');
  assert.match(notifications[0][1],/failed 3 consecutive times/);
});

test('failed social failure-notification does not change watcher failure state or crash polling',async()=>{
 const repository=memoryRepository();
 const service=createSocialWatchService({repository,adapters:new Map([['scraper',{poll:async()=>{throw new Error('broken target');}}]]),
  emitTrigger:async()=>{},notifyOwner:async()=>{throw new Error('delivery down');},failureNotifyThreshold:1});
 const rule=await service.create('user-a',valid('twitter_account','scraper',1));
 assert.deepEqual(await service.processRule(rule),[]);assert.equal(rule.consecutiveFailures,1);
});

test('switching method changes adapter selection without changing watcher core', async () => {
  const repository=memoryRepository(); const calls=[];
  const adapters=new Map(['official_api','managed_service','scraper'].map(method=>[method,{poll:async()=>{calls.push(method);return{items:[]};}}]));
  const service=createSocialWatchService({repository,adapters,emitTrigger:async()=>{}});
  let rule=await service.create('user-a',valid('twitter_account','scraper',1));
  await service.processRule(rule);
  rule=await service.update('user-a',rule.id,{method:'managed_service',config:{handle:'ghostmint'}});
  await service.processRule(rule);
  rule=await service.update('user-a',rule.id,{method:'official_api',config:{handle:'ghostmint'}});
  await service.processRule(rule);
  assert.deepEqual(calls,['scraper','managed_service','official_api']);
});

test('all concrete HTTP adapters normalize items and do not expose credentials', async () => {
  const seen=[]; const usage=[];
  const adapters=createSocialAdapters({request:async input=>{seen.push(input);return{data:{items:[{id:'1',text:ADDRESS}]}};},
    officialApi:{endpoint:'https://official.example/watch',token:'official-secret'},
    managedService:{endpoint:'https://managed.example/watch',token:'managed-secret'},recordUsage:async entry=>usage.push(entry)});
  for (const method of ['official_api','managed_service','scraper']) {
    const result=await adapters.get(method).poll({id:`rule-${method}`,userId:'user-a',name:method,
      type:'twitter_account',config:{handle:'ghostmint',keywords:[],sourceUrl:'https://scrape.example/feed'},cursor:null});
    assert.equal(result.items.length,1);
  }
  assert.deepEqual(usage.map(entry=>[entry.method,entry.requestType,entry.succeeded]),[
    ['official_api','read',true],['managed_service','read',true],['scraper','read',true],
  ]);
  assert.doesNotMatch(JSON.stringify(seen.map(item=>({url:item.url,params:item.params}))),/official-secret|managed-secret/);
});

test('provider-reported cost and credits are captured in durable usage records', async () => {
  const usage=[];
  const adapter=createSocialAdapters({request:async()=>({headers:{'x-request-cost-usd':'0.005','x-credits-used':'1'},data:{items:[]}}),
    officialApi:{endpoint:'https://official.example/watch',token:'token'},recordUsage:async entry=>usage.push(entry)}).get('official_api');
  await adapter.poll({id:ID,userId:'user-a',name:'metered',type:'twitter_account',config:{handle:'ghostmint'},cursor:null});
  assert.equal(usage[0].providerCostUsd,0.005);
  assert.equal(usage[0].providerCredits,1);
});

test('scraper adapter extracts visible content from a credential-free HTML response', async () => {
  const adapter=createSocialAdapters({request:async()=>({data:`<html><style>.x{}</style><body>Mint ${ADDRESS}</body></html>`})}).get('scraper');
  const result=await adapter.poll({type:'twitter_account',config:{sourceUrl:'https://public.example/page'},cursor:null});
  assert.equal(result.items.length,1);
  assert.match(result.items[0].text,/Mint 0x/);
  assert.doesNotMatch(result.items[0].text,/<html>|<style>/);
});

test('Milestone 10b-2: a new watch type (Farcaster) is tagged with its own platform through the same adapter code', async () => {
  const adapter=createSocialAdapters({request:async()=>({data:{items:[{id:'cast-1',text:ADDRESS}]}})}).get('scraper');
  const result=await adapter.poll({type:'farcaster_account',config:{sourceUrl:'https://public.example/casts',handle:'ghostmint',keywords:[]},cursor:null});
  assert.equal(result.items[0].platform,'farcaster');
});

test('an adapter refuses to poll a watch type with no registered platform instead of silently mislabeling it', async () => {
  const adapter=createSocialAdapters({request:async()=>({data:{items:[]}})}).get('scraper');
  await assert.rejects(
    adapter.poll({type:'unknown_type',config:{sourceUrl:'https://public.example/feed'},cursor:null}),
    error=>error.code==='SOCIAL_ADAPTER_FAILED',
  );
});

test('Farcaster account rules follow everything until keywords narrow them, matching the Twitter/Discord account pattern', async () => {
  const repository=memoryRepository(); const emitted=[];
  const adapter={poll:async()=>({items:[{id:'cast-1',text:`ship it ${ADDRESS}`,platform:'farcaster',publishedAt:3_000}]})};
  const service=createSocialWatchService({repository,adapters:new Map([['scraper',adapter]]),emitTrigger:async event=>emitted.push(event),now:()=>3_000});
  const rule=await service.create('user-a',valid('farcaster_account','scraper',1));
  await service.processRule(rule);
  assert.equal(emitted.length,1);
  assert.equal(emitted[0].platform,'farcaster');
});
