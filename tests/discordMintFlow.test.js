const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler, handleMintPasteMessage } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');
const { RateLimitError } = require('../src/security/botSecurity');

// Section AA: Discord's guided mint flow. Mirrors the mock shape and coverage bar set by
// tests/discordFlowUX.test.js (wallet create/import) -- see WORKLIST.md's Section AA note on why
// this flow is held to that precedent rather than server.js's untested mint_guided.

function mockMessage(content, userId = 'paster') {
  return {
    author: { id: userId, bot: false }, guildId: 'guild', channelId: 'channel', content,
    replies: [],
    async reply(payload) { this.replies.push(payload); return { id: 'origin-message' }; },
  };
}

function baseInteraction(userId) {
  const state = {
    user: { id: userId }, guildId: 'guild', channelId: 'channel',
    updates: [], replies: [], modal: null, messageEdits: [],
    message: { edit(payload) { state.messageEdits.push(payload); return Promise.resolve(); } },
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(payload) { this.updates.push(payload); },
    async reply(payload) { this.replies.push(payload); },
    async showModal(payload) { this.modal = payload; },
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

function chatInteraction(commandName, userId = 'discord-user') {
  return {
    commandName, user: { id: userId }, guildId: 'guild', channelId: 'channel',
    deferred: false, replied: false, replies: [],
    isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    options: { getSubcommand: () => null, getString: () => null, getInteger: () => null, getNumber: () => null, getBoolean: () => null },
    async deferReply(options) { this.deferred = true; this.deferOptions = options; },
    async editReply(value) { this.replies.push(value); },
    async reply(value) { this.replied = true; this.replies.push(value); },
  };
}

const CHAINS = { ethereum: { name: 'Ethereum', sym: 'ETH' } };
const NO_LIMIT = { check: () => {} };

function baseCommands(overrides = {}) {
  return {
    parseOpenSeaCollectionSlug: () => null,
    resolveMintContractInput: async input => (/^0x[0-9a-fA-F]{40}$/.test(input) ? input : null),
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 100, maxPerWallet: 1, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
    wallets: () => [{ label: 'main', chain: 'ethereum' }],
    mint: async () => ({ state: 'confirmed', txHash: '0xabc' }),
    batchMint: async () => [],
    ...overrides,
  };
}

test('a single wallet, maxPerWallet 1, and a known price reaches the confirm screen with zero intermediate taps', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const message = mockMessage('0x0000000000000000000000000000000000000001');
  await handleMintPasteMessage({ identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.equal(message.replies.length, 1);
  assert.match(message.replies[0].content, /Confirm mint/);
  assert.match(message.replies[0].content, /Contract details|SeaDrop|Standard mint/);
});

test('maxPerWallet > 1 shows the quantity select with the contract details prepended', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const message = mockMessage('0x0000000000000000000000000000000000000001');
  await handleMintPasteMessage({ identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.match(message.replies[0].content, /Standard mint/);
  assert.match(message.replies[0].content, /How many would you like to mint\? \(max 5 per wallet\)/);
  const select = message.replies[0].components[0].components[0];
  assert.deepEqual(select.options.map(o => o.value), ['1', '2', '5', 'custom']);
});

test('full happy path: paste -> quantity select -> wallet select -> confirm -> mint executes and clears the flow', async () => {
  const flowState = createFlowStateStore();
  const minted = [];
  const commands = baseCommands({
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
    wallets: () => [{ label: 'alpha', chain: 'ethereum' }, { label: 'beta', chain: 'ethereum' }],
    mint: async (userId, input) => { minted.push({ userId, input }); return { state: 'confirmed', txHash: '0xdeadbeef' }; },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-1');
  await handleMintPasteMessage(ctx, message);
  assert.match(message.replies[0].content, /How many would you like to mint/);

  const handler = createDiscordInteractionHandler(ctx);
  const qty = selectInteraction('flow:mintqty:select', ['2'], 'paster-1');
  await handler(qty);
  assert.equal(qty.messageEdits.length, 1, 'the public origin message must be neutralized on first touch');
  assert.equal(qty.replies.length, 1);
  assert.equal(qty.replies[0].ephemeral, true);
  assert.match(qty.replies[0].content, /Choose a wallet/);

  const walletPick = selectInteraction('flow:mintwallet:select', ['beta'], 'paster-1');
  await handler(walletPick);
  assert.equal(walletPick.updates.length, 1, 'already-ephemeral steps update in place, not a fresh reply');
  assert.equal(walletPick.replies.length, 0);
  assert.match(walletPick.updates[0].content, /Confirm mint/);
  assert.match(walletPick.updates[0].content, /beta/);
  assert.match(walletPick.updates[0].content, /Quantity: 2 each/);

  const confirm = buttonInteraction('flow:mintconfirm', 'paster-1');
  await handler(confirm);
  assert.equal(minted.length, 1);
  assert.equal(minted[0].userId, 'internal-user');
  assert.equal(minted[0].input.walletLabel, 'beta');
  assert.equal(minted[0].input.quantity, 2);
  assert.match(confirm.updates[0].content, /Mint confirmed/);

  const stray = buttonInteraction('flow:mintconfirm', 'paster-1');
  await handler(stray);
  assert.match(stray.replies[0].content, /isn't your mint prompt/);
});

test('a different user\'s click on the flow\'s public message is rejected ephemerally and never touches the original flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'owner-1');
  await handleMintPasteMessage(ctx, message);

  const handler = createDiscordInteractionHandler(ctx);
  const strangerClick = selectInteraction('flow:mintqty:select', ['2'], 'stranger-1');
  await handler(strangerClick);
  assert.equal(strangerClick.replies.length, 1);
  assert.equal(strangerClick.replies[0].ephemeral, true);
  assert.match(strangerClick.replies[0].content, /isn't your mint prompt/);
  assert.equal(strangerClick.messageEdits.length, 0, 'a stranger\'s click must not neutralize the owner\'s message');
  assert.equal(strangerClick.updates.length, 0);

  const ownerClick = selectInteraction('flow:mintqty:select', ['2'], 'owner-1');
  await handler(ownerClick);
  assert.equal(ownerClick.messageEdits.length, 1, 'the real owner can still continue normally afterward');
});

test('picking "custom" on the quantity select opens a modal, neutralizing the origin message even though the response is a modal', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 5, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
    wallets: () => [{ label: 'alpha', chain: 'ethereum' }, { label: 'beta', chain: 'ethereum' }],
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-2');
  await handleMintPasteMessage(ctx, message);

  const handler = createDiscordInteractionHandler(ctx);
  const customPick = selectInteraction('flow:mintqty:select', ['custom'], 'paster-2');
  await handler(customPick);
  assert.equal(customPick.modal.custom_id, 'flow:mintqty:submit');
  assert.equal(customPick.messageEdits.length, 1);

  const submit = modalInteraction('flow:mintqty:submit', { value: '3' }, 'paster-2');
  await handler(submit);
  assert.equal(submit.replies[0].ephemeral, true);
  assert.match(submit.replies[0].content, /Choose a wallet/);
});

test('an out-of-range custom quantity is rejected without advancing the flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 5, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-3');
  await handleMintPasteMessage(ctx, message);
  const handler = createDiscordInteractionHandler(ctx);
  await handler(selectInteraction('flow:mintqty:select', ['custom'], 'paster-3'));
  const submit = modalInteraction('flow:mintqty:submit', { value: '99' }, 'paster-3');
  await handler(submit);
  assert.match(submit.replies[0].content, /Send a whole number from 1 to 5/);
  assert.equal(flowState.get('discord', 'paster-3').step, 'awaiting_quantity');
});

test('price step offers the OpenSea floor as a one-tap accept', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: false, maxSupply: 100, maxPerWallet: 1,
    startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: { eth: 0.05, usd: 100 },
  }) });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-4');
  await handleMintPasteMessage(ctx, message);
  assert.match(message.replies[0].content, /OpenSea suggests a floor price/);

  const handler = createDiscordInteractionHandler(ctx);
  const accept = buttonInteraction('flow:priceaccept', 'paster-4');
  await handler(accept);
  assert.match(accept.replies[0].content, /Confirm mint/);
  assert.match(accept.replies[0].content, /using the amount you entered above/);
});

test('manual price entry via modal advances past the price step', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: false, maxSupply: 100, maxPerWallet: 1,
    startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-5');
  await handleMintPasteMessage(ctx, message);
  assert.match(message.replies[0].content, /Enter the price per item/);

  const handler = createDiscordInteractionHandler(ctx);
  const manual = buttonInteraction('flow:pricemanual', 'paster-5');
  await handler(manual);
  assert.equal(manual.modal.custom_id, 'flow:mintprice:submit');

  const submit = modalInteraction('flow:mintprice:submit', { value: '0.02' }, 'paster-5');
  await handler(submit);
  assert.match(submit.replies[0].content, /Confirm mint/);
});

test('a rate limit during execution keeps the flow intact instead of discarding it', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const rateLimiter = { check: () => { throw new RateLimitError(5000); } };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-6');
  await handleMintPasteMessage(ctx, message);
  assert.match(message.replies[0].content, /Confirm mint/);

  const handler = createDiscordInteractionHandler(ctx);
  const confirm = buttonInteraction('flow:mintconfirm', 'paster-6');
  await handler(confirm);
  // this flow reached confirm as its very first screen (single wallet, known price, maxPerWallet
  // 1), so tapping Confirm is the flow's first interaction -- the response goes ephemeral, not an
  // in-place update of the still-public origin message.
  assert.match(confirm.replies[0].content, /Too many sensitive commands/);
  assert.equal(flowState.get('discord', 'paster-6').flow, 'mint_guided');
});

test('pasting an OpenSea collection link resolves through resolveMintContractInput the same as a bare address', async () => {
  const flowState = createFlowStateStore();
  const resolvedCalls = [];
  const commands = baseCommands({
    parseOpenSeaCollectionSlug: input => (input.includes('opensea.io/collection/') ? 'cool-cats' : null),
    resolveMintContractInput: async input => { resolvedCalls.push(input); return '0x0000000000000000000000000000000000000099'; },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const message = mockMessage('https://opensea.io/collection/cool-cats', 'paster-7');
  await handleMintPasteMessage({ identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.deepEqual(resolvedCalls, ['https://opensea.io/collection/cool-cats']);
  assert.match(message.replies[0].content, /0x0000000000000000000000000000000000000099/);
});

test('a second paste while a mint flow is already in progress asks for confirmation instead of silently restarting', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const ctx = { identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  await handleMintPasteMessage(ctx, mockMessage('0x0000000000000000000000000000000000000001', 'paster-8'));
  const second = mockMessage('0x0000000000000000000000000000000000000002', 'paster-8');
  await handleMintPasteMessage(ctx, second);
  assert.match(second.replies[0].content, /minting/);
  assert.deepEqual(second.replies[0].components[0].components.map(b => b.custom_id), ['flow:cancel:confirm', 'flow:cancel:resume']);
});

test('a slash command issued mid mint-flow is intercepted with a cancel-confirmation prompt instead of running', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const ctx = { identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  await handleMintPasteMessage(ctx, mockMessage('0x0000000000000000000000000000000000000001', 'paster-9'));

  const handler = createDiscordInteractionHandler(ctx);
  const slash = chatInteraction('wallet', 'paster-9');
  await handler(slash);
  assert.equal(slash.deferred, false);
  assert.match(slash.replies[0].content, /minting/);
});

test('an invalid or unresolvable contract input is ignored rather than starting a flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ resolveMintContractInput: async () => null });
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-10');
  await handleMintPasteMessage({ identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.equal(message.replies.length, 0);
  assert.equal(flowState.get('discord', 'paster-10'), null);
});
