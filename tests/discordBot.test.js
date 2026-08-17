const assert = require('node:assert/strict');
const test = require('node:test');
const { AuthorizationError } = require('../src/governance/governanceService');
const { commandDefinitions, createDiscordInteractionHandler } = require('../src/discord/discordBot');

function interaction({ commandName, userId = 'discord-user', subcommand = null, strings = {}, integers = {}, numbers = {}, booleans = {} }) {
  return {
    commandName, user: { id: userId }, guildId:'guild',channelId:'channel',deferred: false, replied: false, replies: [],
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: name => strings[name] ?? null,
      getInteger: name => integers[name] ?? null,
      getNumber: name => numbers[name] ?? null,
      getBoolean: name => booleans[name] ?? null,
    },
    async deferReply(options) { this.deferred = true; this.deferOptions = options; },
    async editReply(value) { this.replies.push(value); },
    async reply(value) { this.replied = true; this.replies.push(value); },
  };
}

test('Discord command definitions include the complete Milestone 10a surface', () => {
  const definitions = commandDefinitions();
  const names = definitions.map(command => command.name);
  assert.deepEqual(names, ['menu', 'wallet', 'deposit', 'mint', 'batch-mint', 'task', 'activity', 'pnl', 'gas', 'sniper', 'mode', 'admin', 'link', 'watch', 'social-usage', 'target-policy', 'confirm-trigger', 'trigger-audit', 'pending', 'transactions']);
  const wallet = definitions.find(command => command.name === 'wallet');
  const create = wallet.options.find(option => option.name === 'create');
  const imported = wallet.options.find(option => option.name === 'import');
  assert.doesNotMatch(JSON.stringify(create), /private-key/);
  assert.match(imported.description, /Not recommended/);
  assert.match(imported.options.find(option => option.name === 'private-key').description, /transit|history/);
  const link = definitions.find(command => command.name === 'link');
  const linkCode = link.options.find(option => option.name === 'code');
  assert.equal(linkCode.required, true, 'Discord must never be able to generate a link code, only consume one');
});

test('Discord /link without a code cannot generate one and does not touch identity resolution', async () => {
  let generated = false;
  const input = interaction({ commandName: 'link', strings: {} });
  const handler = createDiscordInteractionHandler({
    identity: { createLinkCode: async () => { generated = true; return { code: 'should-not-happen' }; }, resolveOrCreate: async () => 'user-a' },
    commands: {},
  });
  await handler(input);
  assert.equal(generated, false);
  assert.match(input.replies[0], /link code is required.*Telegram/i);
});

test('Discord wallet creation returns only a funding address and import explains platform exposure', async () => {
  const createdInteraction = interaction({ commandName: 'wallet', subcommand: 'create', strings: { label: 'fresh', chain: 'ethereum' } });
  const importedInteraction = interaction({ commandName: 'wallet', subcommand: 'import', strings: {
    label: 'existing', chain: 'ethereum', 'private-key': `0x${'11'.repeat(32)}`,
  } });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' },
    commands: {
      createWallet: async () => ({ label: 'fresh', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' }),
      importWallet: async () => ({ label: 'existing', address: '0x0000000000000000000000000000000000000002', chain: 'ethereum' }),
    },
  });
  await handler(createdInteraction);
  await handler(importedInteraction);
  assert.match(createdInteraction.replies[0], /Fund this public address/);
  assert.doesNotMatch(createdInteraction.replies[0], /private-key|0x111111/);
  assert.match(importedInteraction.replies[0], /not recommended/i);
  assert.match(importedInteraction.replies[0], /transit.*history|history.*transit/i);
});

test('every normal Discord command resolves the sender identity before dispatch', async () => {
  const resolved = [];
  const input = interaction({ commandName: 'activity', userId: 'discord-42' });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async (...args) => { resolved.push(args); return 'user-42'; } },
    commands: { activityPage: async userId => ({page:1,totalPages:1,total:1,
      items:[{ userId, status: 'success', title: 'owned', walletLabel: 'alpha' }]}) },
  });
  await handler(input);
  assert.deepEqual(resolved, [['discord', 'discord-42']]);
  assert.match(input.replies[0], /owned/);
});

test('Discord list dispatch passes only the resolved internal user ID to scoped services', async () => {
  const seen = [];
  const input = interaction({ commandName: 'wallet', subcommand: 'list' });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' },
    commands: { wallets: userId => { seen.push(userId); return [{ label: 'alpha', address: '0x1', chain: 'ethereum' }]; } },
  });
  await handler(input);
  assert.deepEqual(seen, ['user-a']);
  assert.match(input.replies[0], /alpha/);
});

test('Discord link consumption joins an existing identity without auto-creating a second user', async () => {
  let resolved = false;
  const input = interaction({ commandName: 'link', strings: { code: 'ABC123' } });
  const handler = createDiscordInteractionHandler({ identity: {
    resolveOrCreate: async () => { resolved = true; },
    consumeLinkCode: async data => { assert.equal(data.platform, 'discord'); return 'telegram-user'; },
  }, commands: {} });
  await handler(input);
  assert.equal(resolved, false);
  assert.match(input.replies[0], /telegram\\-user/);
});

test('non-owner Discord admin invocation is rejected and audited', async () => {
  const audit=[];
  const input = interaction({ commandName: 'admin', strings: { action: 'group-delete Standard' },booleans:{confirm:true} });
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'regular-user' },
    commands: { admin: async () => { throw new AuthorizationError(); } },securityAudit:{record:async value=>audit.push(value)} });
  await handler(input);
  assert.equal(input.deferOptions.ephemeral, true);
  assert.equal(input.replies[0], 'Owner access required.');
  assert.equal(audit[0].outcome,'unauthorized');assert.equal(audit[0].platformUserId,'discord-user');
});

test('Discord destructive action requires explicit confirmation before dispatch',async()=>{
 let removed=false;const input=interaction({commandName:'wallet',subcommand:'remove',strings:{label:'alpha'},booleans:{confirm:false}});
 await createDiscordInteractionHandler({identity:{resolveOrCreate:async()=> 'u'},commands:{removeWallet:async()=>{removed=true;}}})(input);
 assert.equal(removed,false);assert.match(input.replies[0],/confirm/i);
});

test('/gas degrades to an "unavailable" message instead of a generic failure when the provider has no data for a chain', async () => {
  const input = interaction({ commandName: 'gas', strings: { chain: 'robinhood' } });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' },
    commands: { gas: async () => { throw new Error('Gas lookup is unavailable for that chain'); } },
  });
  await handler(input);
  assert.equal(input.replies[0], 'robinhood: gas data unavailable right now\\.');
});

test('/gas still reports real figures when the provider has data', async () => {
  const input = interaction({ commandName: 'gas', strings: { chain: 'ethereum' } });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' },
    commands: { gas: async chain => ({ chain, gasPriceGwei: 12, maxFeePerGasGwei: 20 }) },
  });
  await handler(input);
  assert.equal(input.replies[0], 'ethereum: gas 12 Gwei, max fee 20 Gwei\\.');
});
