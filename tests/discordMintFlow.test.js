const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler, handleMintPasteMessage } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');
const { RateLimitError } = require('../src/security/botSecurity');

// Section AA: Discord's guided mint flow. Mirrors the mock shape and coverage bar set by
// tests/discordFlowUX.test.js (wallet create/import) -- see WORKLIST.md's Section AA note on why
// this flow is held to that precedent rather than server.js's untested mint_guided.
//
// Section AD Tier 1 changed this flow's shape: a paste no longer jumps straight to
// quantity/wallet/price/confirm -- it always lands on the collection info card
// (awaiting_details) first, and reaching the rest of the flow now requires one extra tap on the
// card's "Mint Now" button (flow:mintdetailscontinue). That tap is what neutralizes the public
// origin message and flips originMessagePublic to false, so every test below that used to treat
// its first flow-continuation tap as "the first touch" now performs that tap via
// flow:mintdetailscontinue instead, and whatever was previously the first touch becomes the
// second (already-ephemeral, update-in-place) one.

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

function chatInteraction(commandName, userId = 'discord-user', strings = {}) {
  return {
    commandName, user: { id: userId }, guildId: 'guild', channelId: 'channel',
    deferred: false, replied: false, replies: [],
    isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    options: { getSubcommand: () => null, getString: name => strings[name] ?? null, getInteger: () => null, getNumber: () => null, getBoolean: () => null },
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

test('a paste always lands on the collection details card first', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const message = mockMessage('0x0000000000000000000000000000000000000001');
  await handleMintPasteMessage({ identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.equal(message.replies.length, 1);
  assert.match(message.replies[0].content, /Contract details|SeaDrop|Standard mint/);
  assert.match(message.replies[0].content, /0x0000000000000000000000000000000000000001/);
  assert.deepEqual(message.replies[0].components[0].components.map(b => b.custom_id), ['flow:mintdetailscontinue']);
});

test('/info shows the same collection card as a paste, with no mint intent implied', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const ctx = { identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const handler = createDiscordInteractionHandler(ctx);
  const slash = chatInteraction('info', 'looker-1', { contract: '0x0000000000000000000000000000000000000001' });
  await handler(slash);
  assert.equal(slash.deferred, true);
  assert.match(slash.replies[0].content, /Contract details|SeaDrop|Standard mint/);
  assert.deepEqual(slash.replies[0].components[0].components.map(b => b.custom_id), ['flow:mintdetailscontinue']);
  assert.equal(flowState.get('discord', 'looker-1').flow, 'mint_guided');
});

test('flow:detailsrefresh re-fetches live stats and updates the card in place without neutralizing the public origin message', async () => {
  const flowState = createFlowStateStore();
  let calls = 0;
  const commands = baseCommands({
    detectMintContract: async () => {
      calls += 1;
      return {
        chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
        maxSupply: 100, maxPerWallet: 1, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
        stats: calls === 1 ? null : {
          floorPrice: 0.09, floorPriceSymbol: 'ETH', numOwners: 7, totalMinted: 10, marketCap: 0.9,
          volume: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null },
        },
      };
    },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-11');
  await handleMintPasteMessage(ctx, message);
  assert.equal(message.replies[0].content.includes('Floor'), false);

  const handler = createDiscordInteractionHandler(ctx);
  const refresh = buttonInteraction('flow:detailsrefresh', 'paster-11');
  await handler(refresh);
  assert.equal(calls, 2);
  assert.equal(refresh.messageEdits.length, 0, 'refresh must not neutralize the public origin message');
  assert.equal(refresh.replies.length, 0);
  assert.equal(refresh.updates.length, 1);
  assert.match(refresh.updates[0].content, /Floor\s+0\.09 ETH/);
  assert.match(refresh.updates[0].content, /Holders\s+7/);
  assert.equal(flowState.get('discord', 'paster-11').step, 'awaiting_details');
});

test('a transient failure during flow:detailsrefresh leaves the last-known card values in place instead of erroring out', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-12');
  await handleMintPasteMessage(ctx, message);

  const failingCtx = { ...ctx, commands: { ...commands, detectMintContract: async () => { throw new Error('rate limited'); } } };
  const handler = createDiscordInteractionHandler(failingCtx);
  const refresh = buttonInteraction('flow:detailsrefresh', 'paster-12');
  await handler(refresh);
  assert.equal(refresh.updates.length, 1);
  assert.match(refresh.updates[0].content, /0x0000000000000000000000000000000000000001/);
  assert.equal(flowState.get('discord', 'paster-12').step, 'awaiting_details');
});

test('flow:copyca replies with a copy-friendly echo of the address without touching flow state or the origin message', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-13');
  await handleMintPasteMessage(ctx, message);

  const handler = createDiscordInteractionHandler(ctx);
  const copy = buttonInteraction('flow:copyca', 'paster-13');
  await handler(copy);
  assert.equal(copy.replies.length, 1);
  assert.equal(copy.replies[0].ephemeral, true);
  assert.match(copy.replies[0].content, /0x0000000000000000000000000000000000000001/);
  assert.equal(copy.messageEdits.length, 0);
  assert.equal(copy.updates.length, 0);
  assert.equal(flowState.get('discord', 'paster-13').step, 'awaiting_details');
});

test('tapping Mint Now on a single wallet, maxPerWallet 1, known-price contract reaches the confirm screen with no further taps', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001');
  await handleMintPasteMessage(ctx, message);

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster');
  await handler(mintNow);
  assert.equal(mintNow.messageEdits.length, 1, 'the public origin message must be neutralized on the Mint Now tap');
  assert.equal(mintNow.replies.length, 1);
  assert.equal(mintNow.replies[0].ephemeral, true);
  assert.match(mintNow.replies[0].content, /Confirm mint/);
});

test('maxPerWallet > 1 shows the quantity select after the Mint Now tap', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001');
  await handleMintPasteMessage(ctx, message);
  assert.match(message.replies[0].content, /Standard mint/);

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster');
  await handler(mintNow);
  assert.match(mintNow.replies[0].content, /How many would you like to mint\? \(max 5 per wallet\)/);
  const select = mintNow.replies[0].components[0].components[0];
  assert.deepEqual(select.options.map(o => o.value), ['1', '2', '5', 'custom']);
});

test('full happy path: paste -> details card -> Mint Now -> quantity select -> wallet select -> confirm -> mint executes and clears the flow', async () => {
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
  assert.match(message.replies[0].content, /Contract details|Standard mint/);

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster-1');
  await handler(mintNow);
  assert.equal(mintNow.messageEdits.length, 1, 'the public origin message must be neutralized on first touch');
  assert.equal(mintNow.replies.length, 1);
  assert.equal(mintNow.replies[0].ephemeral, true);
  assert.match(mintNow.replies[0].content, /How many would you like to mint/);

  const qty = selectInteraction('flow:mintqty:select', ['2'], 'paster-1');
  await handler(qty);
  assert.equal(qty.messageEdits.length, 0, 'already neutralized by the earlier Mint Now tap');
  assert.equal(qty.updates.length, 1, 'already-ephemeral steps update in place, not a fresh reply');
  assert.equal(qty.replies.length, 0);
  assert.match(qty.updates[0].content, /Choose a wallet/);

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
  const strangerClick = buttonInteraction('flow:mintdetailscontinue', 'stranger-1');
  await handler(strangerClick);
  assert.equal(strangerClick.replies.length, 1);
  assert.equal(strangerClick.replies[0].ephemeral, true);
  assert.match(strangerClick.replies[0].content, /isn't your mint prompt/);
  assert.equal(strangerClick.messageEdits.length, 0, 'a stranger\'s click must not neutralize the owner\'s message');
  assert.equal(strangerClick.updates.length, 0);

  const ownerClick = buttonInteraction('flow:mintdetailscontinue', 'owner-1');
  await handler(ownerClick);
  assert.equal(ownerClick.messageEdits.length, 1, 'the real owner can still continue normally afterward');
});

test('picking "custom" on the quantity select opens a modal; the origin message was already neutralized by the earlier Mint Now tap', async () => {
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
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster-2');
  await handler(mintNow);
  assert.equal(mintNow.messageEdits.length, 1);

  const customPick = selectInteraction('flow:mintqty:select', ['custom'], 'paster-2');
  await handler(customPick);
  assert.equal(customPick.modal.custom_id, 'flow:mintqty:submit');
  assert.equal(customPick.messageEdits.length, 0, 'already neutralized by the earlier Mint Now tap');

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
  await handler(buttonInteraction('flow:mintdetailscontinue', 'paster-3'));
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

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster-4');
  await handler(mintNow);
  assert.match(mintNow.replies[0].content, /OpenSea suggests a floor price/);

  const accept = buttonInteraction('flow:priceaccept', 'paster-4');
  await handler(accept);
  assert.equal(accept.updates.length, 1, 'already ephemeral by this point -- updates in place, not a fresh reply');
  assert.match(accept.updates[0].content, /Confirm mint/);
  assert.match(accept.updates[0].content, /using the amount you entered above/);
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

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster-5');
  await handler(mintNow);
  assert.match(mintNow.replies[0].content, /Enter the price per item/);

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

  const handler = createDiscordInteractionHandler(ctx);
  const mintNow = buttonInteraction('flow:mintdetailscontinue', 'paster-6');
  await handler(mintNow);
  assert.match(mintNow.replies[0].content, /Confirm mint/);

  const confirm = buttonInteraction('flow:mintconfirm', 'paster-6');
  await handler(confirm);
  // Mint Now was this flow's first interaction (single wallet, known price, maxPerWallet 1 needs
  // no further taps to reach confirm), so by the time Confirm is tapped the flow is already
  // ephemeral -- the rate-limit message updates that same ephemeral message in place rather than
  // sending a fresh reply.
  assert.equal(confirm.updates.length, 1);
  assert.match(confirm.updates[0].content, /Too many sensitive commands/);
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

test('a second paste while a mint flow is already in progress silently abandons it and starts fresh with the new address', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const ctx = { identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  await handleMintPasteMessage(ctx, mockMessage('0x0000000000000000000000000000000000000001', 'paster-8'));
  assert.equal(flowState.get('discord', 'paster-8').data.contractAddress, '0x0000000000000000000000000000000000000001');

  const second = mockMessage('0x0000000000000000000000000000000000000002', 'paster-8');
  await handleMintPasteMessage(ctx, second);
  assert.match(second.replies[0].content, /0x0000000000000000000000000000000000000002/, 'shows the card for the new contract, not a confirmation prompt');
  assert.equal(flowState.get('discord', 'paster-8').data.contractAddress, '0x0000000000000000000000000000000000000002', 'the first flow was abandoned, not merged with the second');
});

test('a slash command issued mid mint-flow silently abandons the flow and runs normally, no confirmation', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ detectMintContract: async () => ({
    chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
    maxSupply: 100, maxPerWallet: 5, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
  }) });
  const ctx = { identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  await handleMintPasteMessage(ctx, mockMessage('0x0000000000000000000000000000000000000001', 'paster-9'));

  const handler = createDiscordInteractionHandler(ctx);
  const slash = chatInteraction('menu', 'paster-9');
  await handler(slash);
  assert.equal(slash.deferred, true, 'the command actually ran (deferred+replied), not intercepted');
  assert.match(slash.replies[0].content, /GhostMint/);
  assert.equal(flowState.get('discord', 'paster-9'), null, 'the mint flow was abandoned');
});

test('an invalid or unresolvable contract input is ignored rather than starting a flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ resolveMintContractInput: async () => null });
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-10');
  await handleMintPasteMessage({ identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);
  assert.equal(message.replies.length, 0);
  assert.equal(flowState.get('discord', 'paster-10'), null);
});
