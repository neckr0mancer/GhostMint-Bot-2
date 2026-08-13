const assert = require('node:assert/strict');
const test = require('node:test');
const { createSocialWatchService } = require('../src/social/socialWatchService');

const ADDRESS = '0x000000000000000000000000000000000000dEaD';

function memoryRepository() {
  const rules = [];
  const events = new Map();
  return {
    rules, events,
    async create(userId, rule) { const value = { ...rule, id:`rule-${rules.length}`, userId, cursor:null, consecutiveFailures:0 }; rules.push(value); return value; },
    async get(userId, id) { return rules.find(rule => rule.userId === userId && rule.id === id) || null; },
    async list(userId) { return rules.filter(rule => rule.userId === userId); },
    async listEnabledForChannel(channelId) { return rules.filter(rule => rule.enabled && rule.type === 'discord_channel' && rule.config.channelId === channelId); },
    async update(userId, id, value) { const rule = await this.get(userId, id); if (!rule) return null; Object.assign(rule, value); return rule; },
    async remove(userId, id) { const index = rules.findIndex(rule => rule.userId === userId && rule.id === id); if (index < 0) return false; rules.splice(index,1); return true; },
    async listDue() { return rules.filter(rule => rule.enabled); },
    async markSuccess(rule, value) { rule.cursor = value.cursor; rule.consecutiveFailures = 0; },
    async markFailure(rule) { rule.consecutiveFailures += 1; return rule.consecutiveFailures; },
    async createTrigger(event) { if (events.has(event.dedupKey)) return null; const value = { ...event, id:`event-${events.size}` }; events.set(event.dedupKey, value); return value; },
  };
}

function rule(overrides = {}) {
  return { name:'announcements', type:'discord_channel', method:'scraper',
    config:{ channelId:'chan-1', keywords:[], sourceUrl:'https://source.example/feed' }, enabled:true, ...overrides };
}

test('a live discord message immediately triggers only the enabled rules watching that channel', async () => {
  const repository = memoryRepository();
  const emitted = [];
  const service = createSocialWatchService({ repository, adapters:new Map(), emitTrigger: async event => emitted.push(event), now: () => 1_000 });
  await service.create('user-a', rule());
  await service.create('user-a', rule({ config:{ channelId:'chan-2', keywords:[], sourceUrl:'https://source.example/feed' } })); // different channel
  await service.create('user-b', rule({ enabled:false })); // disabled

  const item = { platform:'discord', id:'msg-1', text:`New mint ${ADDRESS}`, url:'https://discord.com/x', publishedAt:1_000, channelId:'chan-1' };
  const triggers = await service.processLiveDiscordMessage(item);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].address, ADDRESS);
  assert.equal(emitted.length, 1);
});

test('the same live message delivered twice (e.g. a Gateway reconnect replay) is deduplicated, not double-fired', async () => {
  const repository = memoryRepository();
  const emitted = [];
  const service = createSocialWatchService({ repository, adapters:new Map(), emitTrigger: async event => emitted.push(event), now: () => 1_000 });
  await service.create('user-a', rule());
  const item = { platform:'discord', id:'msg-1', text:`New mint ${ADDRESS}`, url:'https://discord.com/x', publishedAt:1_000, channelId:'chan-1' };
  const first = await service.processLiveDiscordMessage(item);
  const second = await service.processLiveDiscordMessage(item);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(emitted.length, 1);
});

test('two different users watching the same channel each get their own trigger', async () => {
  const repository = memoryRepository();
  const emitted = [];
  const service = createSocialWatchService({ repository, adapters:new Map(), emitTrigger: async event => emitted.push(event), now: () => 1_000 });
  await service.create('user-a', rule());
  await service.create('user-b', rule());
  const item = { platform:'discord', id:'msg-1', text:`New mint ${ADDRESS}`, url:'https://discord.com/x', publishedAt:1_000, channelId:'chan-1' };
  const triggers = await service.processLiveDiscordMessage(item);
  assert.equal(triggers.length, 2);
  assert.deepEqual(new Set(triggers.map(event => event.userId)), new Set(['user-a', 'user-b']));
});

test('one rule failing to record a live trigger is isolated and does not block another rule in the same channel', async () => {
  const repository = memoryRepository();
  let calls = 0;
  const originalCreateTrigger = repository.createTrigger.bind(repository);
  repository.createTrigger = async event => { calls += 1; if (calls === 1) throw new Error('db hiccup'); return originalCreateTrigger(event); };
  const emitted = []; const logs = [];
  const service = createSocialWatchService({ repository, adapters:new Map(), emitTrigger: async event => emitted.push(event), log: message => logs.push(message), now: () => 1_000 });
  await service.create('user-a', rule());
  await service.create('user-b', rule());
  const item = { platform:'discord', id:'msg-2', text:`Mint now ${ADDRESS}`, url:'https://discord.com/y', publishedAt:1_000, channelId:'chan-1' };
  const triggers = await service.processLiveDiscordMessage(item);
  assert.equal(triggers.length, 1);
  assert.ok(logs.some(message => message.includes('db hiccup')));
});

test('a message with no address and a message in an unwatched channel produce no triggers', async () => {
  const repository = memoryRepository();
  const emitted = [];
  const service = createSocialWatchService({ repository, adapters:new Map(), emitTrigger: async event => emitted.push(event), now: () => 1_000 });
  await service.create('user-a', rule());
  const noAddress = await service.processLiveDiscordMessage({ platform:'discord', id:'msg-3', text:'gm everyone', url:'https://discord.com/z', publishedAt:1_000, channelId:'chan-1' });
  const wrongChannel = await service.processLiveDiscordMessage({ platform:'discord', id:'msg-4', text:`Mint ${ADDRESS}`, url:'https://discord.com/z', publishedAt:1_000, channelId:'chan-9' });
  assert.equal(noAddress.length, 0);
  assert.equal(wrongChannel.length, 0);
  assert.equal(emitted.length, 0);
});
