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
  assert.deepEqual(names, ['menu', 'start', 'wallet', 'deposit', 'mint', 'info', 'batch-mint', 'task', 'activity', 'pnl', 'gas', 'sniper', 'mode', 'admin', 'link', 'watch', 'social-usage', 'target-policy', 'confirm-trigger', 'trigger-audit', 'pending', 'transactions']);
  const wallet = definitions.find(command => command.name === 'wallet');
  const create = wallet.options.find(option => option.name === 'create');
  const imported = wallet.options.find(option => option.name === 'import');
  assert.doesNotMatch(JSON.stringify(create), /private-key/);
  assert.match(imported.description, /Import wallet/);
  assert.match(imported.description, /not recommended/i);
  assert.match(imported.options.find(option => option.name === 'private-key').description, /transit|history/);
  const link = definitions.find(command => command.name === 'link');
  const linkCode = link.options.find(option => option.name === 'code');
  assert.equal(linkCode.required, true, 'Discord must never be able to generate a link code, only consume one');
});

test('/start auto-creates a first wallet for a brand-new user and shows the welcome text plus the main menu', async () => {
  const created = [];
  const input = interaction({ commandName: 'start', userId: 'discord-new' });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-new' },
    supportedChains: ['ethereum'],
    commands: {
      wallets: userId => (created.some(c => c.userId === userId) ? [{ label: 'wallet-1', address: '0x1', chain: 'ethereum' }] : []),
      createWallet: async (userId, input2) => { created.push({ userId, ...input2 }); return { label: 'wallet-1', address: '0x1', chain: 'ethereum' }; },
    },
  });
  await handler(input);
  assert.equal(created.length, 1);
  assert.equal(created[0].chain, 'ethereum');
  assert.match(input.replies[0].content, /gm\. i mint things/);
  assert.match(input.replies[0].content, /Wallet created: wallet-1/);
  assert.ok(input.replies[0].components.some(row => row.components.some(c => c.custom_id === 'menu:wallets')), 'the real main menu panel, not just the welcome text');
});

test('/start does not auto-create a second wallet for a returning user, but still shows the welcome text', async () => {
  const created = [];
  const input = interaction({ commandName: 'start', userId: 'discord-existing' });
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-existing' },
    supportedChains: ['ethereum'],
    commands: {
      wallets: () => [{ label: 'main', address: '0xabc', chain: 'ethereum' }],
      createWallet: async (userId, input2) => { created.push({ userId, ...input2 }); return { label: 'wallet-1', address: '0x1', chain: 'ethereum' }; },
    },
  });
  await handler(input);
  assert.equal(created.length, 0);
  assert.match(input.replies[0].content, /gm\. i mint things/);
  assert.equal(input.replies[0].content.includes('Wallet created'), false);
});

test('every chain option offers the actual configured chains as a picker instead of free text', () => {
  const supportedChains = ['ethereum', 'base'];
  const chains = { ethereum: { name: 'Ethereum' }, base: { name: 'Base' } };
  const definitions = commandDefinitions({ supportedChains, chains });
  const expectedChoices = [{ name: 'Ethereum', value: 'ethereum' }, { name: 'Base', value: 'base' }];
  const namesAndValues = choices => choices.map(({ name, value }) => ({ name, value }));

  const wallet = definitions.find(command => command.name === 'wallet');
  for (const sub of ['create', 'import', 'batch-import']) {
    const chainOption = wallet.options.find(option => option.name === sub).options.find(option => option.name === 'chain');
    assert.deepEqual(namesAndValues(chainOption.choices), expectedChoices, `wallet ${sub} chain choices`);
    assert.equal(chainOption.required, true, `wallet ${sub} chain must stay required`);
  }

  const mint = definitions.find(command => command.name === 'mint');
  const mintChain = mint.options.find(option => option.name === 'chain');
  assert.deepEqual(namesAndValues(mintChain.choices), expectedChoices);
  assert.equal(mintChain.required, false, 'mint chain stays optional -- auto-detected when omitted');
  assert.match(mintChain.description, /auto-detected/);

  const batchMint = definitions.find(command => command.name === 'batch-mint');
  const batchMintChain = batchMint.options.find(option => option.name === 'chain');
  assert.deepEqual(namesAndValues(batchMintChain.choices), expectedChoices);
  assert.equal(batchMintChain.required, false, 'batch-mint chain stays optional -- auto-detected when omitted, same as /mint');

  const gas = definitions.find(command => command.name === 'gas');
  const gasChain = gas.options.find(option => option.name === 'chain');
  assert.deepEqual(namesAndValues(gasChain.choices), expectedChoices);
  assert.equal(gasChain.required, false, 'gas chain stays optional -- it defaults to ethereum at dispatch time');
});

test('a chain option degrades to plain free text, not an error, when no chains are passed in', () => {
  const definitions = commandDefinitions();
  const gas = definitions.find(command => command.name === 'gas');
  const gasChain = gas.options.find(option => option.name === 'chain');
  assert.equal(gasChain.choices, undefined);
});

test('target-policy type is always sniper-or-social_rule choices, independent of chain config', () => {
  const definitions = commandDefinitions();
  const targetPolicy = definitions.find(command => command.name === 'target-policy');
  const expectedChoices = [{ name: 'Sniper', value: 'sniper' }, { name: 'Social Rule', value: 'social_rule' }];
  for (const sub of ['show', 'bypass', 'reset']) {
    const typeOption = targetPolicy.options.find(option => option.name === sub).options.find(option => option.name === 'type');
    assert.deepEqual(typeOption.choices.map(({ name, value }) => ({ name, value })), expectedChoices, `target-policy ${sub} type choices`);
    assert.equal(typeOption.required, true);
  }
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

// The dev-guild pairing: DISCORD_DEV_GUILD_ID both scopes registration to one guild and locks every
// command to it. Leaving it unset has to flip BOTH halves, or the bot ends up with commands visible
// everywhere that only work in one place (or vice versa).
test('start registers globally with no dev guild, and guild-scoped with one', async () => {
  const { createDiscordBot } = require('../src/discord/discordBot');
  const calls = [];
  const fakeRest = { put: async (route, payload) => { calls.push({ route, count: payload.body.length }); } };
  const fakeClient = { on() {}, login: async () => {}, user: { id: 'bot' }, destroy: async () => {} };

  const open = createDiscordBot({ token: 't', applicationId: '123456789012345678', devGuildId: null,
    identity: {}, commands: {}, client: fakeClient, rest: fakeRest });
  await open.start();
  assert.equal(calls.length, 1);
  assert.match(calls[0].route, /applications\/123456789012345678\/commands$/);
  assert.equal(calls[0].route.includes('/guilds/'), false);
  assert.ok(calls[0].count > 0);

  const dev = createDiscordBot({ token: 't', applicationId: '123456789012345678', devGuildId: '223456789012345678',
    identity: {}, commands: {}, client: fakeClient, rest: fakeRest });
  await dev.start();
  assert.match(calls[1].route, /applications\/123456789012345678\/guilds\/223456789012345678\/commands$/);
  assert.equal(calls[0].count, calls[1].count);
});

test('with no dev guild a command from any guild is served, and DMs are too', async () => {
  const handler = createDiscordInteractionHandler({
    allowedGuildId: null,
    identity: { resolveOrCreate: async () => 'user-a' },
    commands: { gas: async () => ({ safeGasPriceGwei: 1, gasPriceGwei: 2, maxFeePerGasGwei: 3 }) },
    chains: { ethereum: { name: 'Ethereum' } },
  });
  const elsewhere = interaction({ commandName: 'gas' });
  elsewhere.guildId = 'some-other-guild';
  await handler(elsewhere);
  assert.ok(elsewhere.replies.length, 'a command from another guild should be answered');

  const dm = interaction({ commandName: 'gas' });
  dm.guildId = null;
  dm.channelId = 'dm-channel';
  await handler(dm);
  assert.ok(dm.replies.length, 'a DM should be answered when no dev guild is configured');
});

test('with a dev guild set, a command from a different guild is still refused', async () => {
  let resolved = false;
  const handler = createDiscordInteractionHandler({
    allowedGuildId: 'guild',
    identity: { resolveOrCreate: async () => { resolved = true; return 'user-a'; } },
    commands: { gas: async () => ({ safeGasPriceGwei: 1, gasPriceGwei: 2, maxFeePerGasGwei: 3 }) },
    chains: { ethereum: { name: 'Ethereum' } },
  });
  const outsider = interaction({ commandName: 'gas' });
  outsider.guildId = 'not-the-dev-guild';
  await handler(outsider);
  assert.equal(resolved, false, 'an unauthorized guild must not even resolve an identity');
});

test('a channel allowlist stops a command in an unlisted channel before identity resolution', async () => {
  let resolved = false;
  const build = allowedChannelIds => createDiscordInteractionHandler({
    allowedGuildId: null, allowedChannelIds,
    identity: { resolveOrCreate: async () => { resolved = true; return 'user-a'; } },
    commands: { gas: async () => ({ safeGasPriceGwei: 1, gasPriceGwei: 2, maxFeePerGasGwei: 3 }) },
    chains: { ethereum: { name: 'Ethereum' } },
  });

  const wrong = interaction({ commandName: 'gas' });
  wrong.channelId = 'not-the-one';
  await build(['111111111111111111'])(wrong);
  assert.equal(resolved, false, 'an unlisted channel must not even resolve an identity');
  assert.match(JSON.stringify(wrong.replies[0]), /not enabled here/, 'the user is told why, not left in silence');

  const right = interaction({ commandName: 'gas' });
  right.channelId = '111111111111111111';
  await build(['111111111111111111'])(right);
  assert.ok(right.replies.length, 'the listed channel is served');
});

test('running global clears leftover guild-scoped commands, and running a dev guild does not', async () => {
  const { createDiscordBot } = require('../src/discord/discordBot');
  const fakeClient = { on() {}, login: async () => {}, user: { id: 'bot' }, destroy: async () => {} };
  const build = (devGuildId, guildCommands) => {
    const puts = [];
    const rest = {
      put: async (route, payload) => { puts.push({ route, count: payload.body.length }); },
      get: async route => {
        if (route.endsWith('/users/@me/guilds')) return [{ id: 'g-stale' }, { id: 'g-clean' }];
        return route.includes('g-stale') ? guildCommands : [];
      },
    };
    return { bot: createDiscordBot({ token: 't', applicationId: '123456789012345678', devGuildId,
      identity: {}, commands: {}, client: fakeClient, rest }), puts };
  };

  const global = build(null, [{ name: 'wallet' }, { name: 'mint' }]);
  await global.bot.start();
  const cleared = global.puts.filter(p => p.count === 0 && p.route.includes('g-stale'));
  assert.equal(cleared.length, 1, 'the guild holding stale commands is cleared exactly once');
  assert.equal(global.puts.some(p => p.route.includes('g-clean')), false, 'a guild with none is left alone');

  const dev = build('223456789012345678', [{ name: 'wallet' }]);
  await dev.bot.start();
  assert.equal(dev.puts.length, 1, 'a dev-guild bot registers and sweeps nothing');
  assert.ok(dev.puts[0].count > 0);
});
