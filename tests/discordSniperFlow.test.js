const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');

// Section R, Phase 1 -- Discord's only prior sniper-creation path was /sniper create with a
// hand-typed JSON blob; this is the guided flow's own integration coverage, mirroring the mock
// shape established by tests/discordMintFlow.test.js and tests/discordTaskFlow.test.js.

function baseInteraction(userId) {
  const state = {
    user: { id: userId }, guildId: 'guild', channelId: 'channel',
    updates: [], replies: [], modal: null, deferred: false, deferredMode: null,
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(payload) { this.updates.push(payload); },
    async reply(payload) { this.replies.push(payload); },
    async showModal(payload) { this.modal = payload; },
    // handleComponent defers every non-modal-opening tap up front (interaction.deferUpdate()); once
    // deferred, dcRespond can only answer via editReply(), same real-Discord constraint
    // tests/discordTaskFlow.test.js's fixture documents.
    async deferUpdate() { this.deferred = true; this.deferredMode = 'update'; },
    async deferReply(options) { this.deferred = true; this.deferredMode = 'reply'; this.deferOptions = options; },
    async editReply(payload) { (this.deferredMode === 'update' ? this.updates : this.replies).push(payload); },
    async followUp(payload) { this.replies.push(payload); },
  };
  return state;
}

function buttonInteraction(customId, userId = 'discord-user') {
  const i = baseInteraction(userId);
  i.customId = customId;
  i.isButton = () => true;
  return i;
}

function selectInteraction(customId, values, userId = 'discord-user') {
  const i = baseInteraction(userId);
  i.customId = customId;
  i.values = values;
  i.isStringSelectMenu = () => true;
  return i;
}

function modalInteraction(customId, fields, userId = 'discord-user') {
  const i = baseInteraction(userId);
  i.customId = customId;
  i.isModalSubmit = () => true;
  i.fields = { getTextInputValue: name => fields[name] };
  return i;
}

const CHAINS = { ethereum: { name: 'Ethereum', sym: 'ETH' } };
const TARGET = '0x1111111111111111111111111111111111111111';

function baseCommands(overrides = {}) {
  return {
    wallets: () => [{ label: 'main', chain: 'ethereum' }],
    createSniper: async () => { throw new Error('createSniper should have been overridden'); },
    ...overrides,
  };
}

function ctxFor(commands, userId = 'discord-user') {
  return {
    identity: { resolveOrCreate: async () => `internal-${userId}` },
    commands, flowState: createFlowStateStore(), chains: CHAINS, supportedChains: ['ethereum'], rateLimiter: { check: () => {} },
  };
}

test('sniper:create:start opens the combined label+target modal, gated by the snipers action', async () => {
  const commands = baseCommands();
  const handler = createDiscordInteractionHandler(ctxFor(commands));
  const start = buttonInteraction('sniper:create:start', 'sniper-1');
  await handler(start);
  assert.equal(start.modal.custom_id, 'flow:snipercreate:submit');
  const fields = start.modal.components.map(r => r.components[0]);
  assert.deepEqual(fields.map(f => f.custom_id), ['label', 'targetAddress']);
});

test('an invalid target address is rejected without advancing the flow', async () => {
  const commands = baseCommands();
  const ctx = ctxFor(commands, 'sniper-2');
  const handler = createDiscordInteractionHandler(ctx);
  await handler(buttonInteraction('sniper:create:start', 'sniper-2'));
  const submit = modalInteraction('flow:snipercreate:submit', { label: 'Whale copy', targetAddress: 'not-an-address' }, 'sniper-2');
  await handler(submit);
  assert.match(submit.replies[0].content, /does not look like a valid address/);
  assert.equal(ctx.flowState.get('discord', 'sniper-2').step, 'awaiting_label');
});

test('full happy path with more than one wallet: modal -> chain -> wallet -> accept default tolerance -> confirm -> createSniper receives the right shape', async () => {
  const created = [];
  const commands = baseCommands({
    wallets: () => [{ label: 'main', chain: 'ethereum' }, { label: 'cold', chain: 'ethereum' }],
    createSniper: async (userId, input) => { created.push({ userId, input }); return { label: input.label, targetAddress: input.targetAddress, chain: input.chain }; },
  });
  const ctx = ctxFor(commands, 'sniper-3');
  const handler = createDiscordInteractionHandler(ctx);

  await handler(buttonInteraction('sniper:create:start', 'sniper-3'));
  const detailsSubmit = modalInteraction('flow:snipercreate:submit', { label: 'Whale copy', targetAddress: TARGET }, 'sniper-3');
  await handler(detailsSubmit);
  assert.equal(detailsSubmit.replies[0].components[0].components[0].custom_id, 'flow:sniperchain:select');
  assert.equal(ctx.flowState.get('discord', 'sniper-3').step, 'awaiting_chain');

  const chainSelect = selectInteraction('flow:sniperchain:select', ['ethereum'], 'sniper-3');
  await handler(chainSelect);
  assert.equal(ctx.flowState.get('discord', 'sniper-3').step, 'awaiting_wallet');
  const walletOptions = chainSelect.updates[0].components[0].components[0].options;
  assert.deepEqual(walletOptions.map(o => o.value), ['main', 'cold']);

  const walletSelect = selectInteraction('flow:sniperwallet:select', ['cold'], 'sniper-3');
  await handler(walletSelect);
  assert.equal(ctx.flowState.get('discord', 'sniper-3').step, 'awaiting_tolerance');
  assert.deepEqual(walletSelect.updates[0].components[0].components.map(c => c.custom_id), ['flow:snipertoleranceaccept', 'flow:snipertolerancemanual']);

  const accept = buttonInteraction('flow:snipertoleranceaccept', 'sniper-3');
  await handler(accept);
  assert.equal(ctx.flowState.get('discord', 'sniper-3').step, 'awaiting_confirm');
  assert.match(accept.updates[0].content, /Whale copy/);
  assert.match(accept.updates[0].content, /default \(200 gwei\)/);

  const confirm = buttonInteraction('flow:sniperconfirm', 'sniper-3');
  await handler(confirm);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].input, {
    label: 'Whale copy', targetAddress: TARGET, chain: 'ethereum', walletLabel: 'cold',
    maxGasGwei: undefined, maxValueETH: undefined, dailySpendingCapETH: undefined,
  });
  assert.equal(ctx.flowState.get('discord', 'sniper-3'), null);
});

test('a single owned wallet is auto-selected -- the flow never shows a wallet picker', async () => {
  const commands = baseCommands({ wallets: () => [{ label: 'solo', chain: 'ethereum' }] });
  const ctx = ctxFor(commands, 'sniper-4');
  const handler = createDiscordInteractionHandler(ctx);

  await handler(buttonInteraction('sniper:create:start', 'sniper-4'));
  await handler(modalInteraction('flow:snipercreate:submit', { label: 'Solo copy', targetAddress: TARGET }, 'sniper-4'));
  const chainSelect = selectInteraction('flow:sniperchain:select', ['ethereum'], 'sniper-4');
  await handler(chainSelect);
  const flow = ctx.flowState.get('discord', 'sniper-4');
  assert.equal(flow.step, 'awaiting_tolerance');
  assert.equal(flow.data.walletLabel, 'solo');
  assert.deepEqual(chainSelect.updates[0].components[0].components.map(c => c.custom_id), ['flow:snipertoleranceaccept', 'flow:snipertolerancemanual']);
});

test('customizing tolerance opens a modal, and blank fields still fall back to defaults while typed ones carry through', async () => {
  const created = [];
  const commands = baseCommands({
    createSniper: async (userId, input) => { created.push(input); return { label: input.label, targetAddress: input.targetAddress, chain: input.chain }; },
  });
  const ctx = ctxFor(commands, 'sniper-5');
  const handler = createDiscordInteractionHandler(ctx);

  await handler(buttonInteraction('sniper:create:start', 'sniper-5'));
  await handler(modalInteraction('flow:snipercreate:submit', { label: 'Custom caps', targetAddress: TARGET }, 'sniper-5'));
  await handler(selectInteraction('flow:sniperchain:select', ['ethereum'], 'sniper-5'));

  const manual = buttonInteraction('flow:snipertolerancemanual', 'sniper-5');
  await handler(manual);
  assert.equal(manual.modal.custom_id, 'flow:snipertolerance:submit');

  const toleranceSubmit = modalInteraction('flow:snipertolerance:submit', { maxGasGwei: '75', maxValueETH: '', dailySpendingCapETH: '2' }, 'sniper-5');
  await handler(toleranceSubmit);
  assert.match(toleranceSubmit.replies[0].content, /Max gas: 75/);
  assert.match(toleranceSubmit.replies[0].content, /Max value\/fire: default \(0\.1 ETH\)/);
  assert.match(toleranceSubmit.replies[0].content, /Daily cap: 2/);

  await handler(buttonInteraction('flow:sniperconfirm', 'sniper-5'));
  assert.equal(created.length, 1);
  assert.equal(created[0].maxGasGwei, 75);
  assert.equal(created[0].maxValueETH, undefined);
  assert.equal(created[0].dailySpendingCapETH, 2);
});

test('a negative or non-numeric tolerance field is rejected without advancing the flow', async () => {
  const commands = baseCommands();
  const ctx = ctxFor(commands, 'sniper-6');
  const handler = createDiscordInteractionHandler(ctx);

  await handler(buttonInteraction('sniper:create:start', 'sniper-6'));
  await handler(modalInteraction('flow:snipercreate:submit', { label: 'x', targetAddress: TARGET }, 'sniper-6'));
  await handler(selectInteraction('flow:sniperchain:select', ['ethereum'], 'sniper-6'));
  await handler(buttonInteraction('flow:snipertolerancemanual', 'sniper-6'));

  const bad = modalInteraction('flow:snipertolerance:submit', { maxGasGwei: '-5', maxValueETH: '', dailySpendingCapETH: '' }, 'sniper-6');
  await handler(bad);
  assert.match(bad.replies[0].content, /non-negative number/);
  assert.equal(ctx.flowState.get('discord', 'sniper-6').step, 'awaiting_tolerance');
});

test('a ValidationError from createSniper is shown plainly and clears the flow instead of throwing', async () => {
  const { ValidationError } = require('../src/validation/domain');
  const commands = baseCommands({
    createSniper: async () => { throw new ValidationError({ field: 'targetAddress', message: 'must be a valid Ethereum address' }); },
  });
  const ctx = ctxFor(commands, 'sniper-7');
  const handler = createDiscordInteractionHandler(ctx);

  await handler(buttonInteraction('sniper:create:start', 'sniper-7'));
  await handler(modalInteraction('flow:snipercreate:submit', { label: 'x', targetAddress: TARGET }, 'sniper-7'));
  await handler(selectInteraction('flow:sniperchain:select', ['ethereum'], 'sniper-7'));
  await handler(buttonInteraction('flow:snipertoleranceaccept', 'sniper-7'));
  const confirm = buttonInteraction('flow:sniperconfirm', 'sniper-7');
  await handler(confirm);
  assert.match(confirm.updates[0].content, /valid Ethereum address/);
  assert.equal(ctx.flowState.get('discord', 'sniper-7'), null);
});
