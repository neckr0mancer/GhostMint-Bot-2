const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler, handleMintPasteMessage } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');
const { RateLimitError } = require('../src/security/botSecurity');

// Section AF follow-up: Discord's mini schedule flow, branching off the collection card's
// "Schedule for opening" action (only ever shown when a future startTime is detected). Section S
// (a full Discord guided task-schedule flow) remains unbuilt -- this is deliberately scoped to a
// single task creation per tap, not a repeatable multi-phase flow the way Telegram's Section AF
// shape 1 is. Mirrors the mock shape established by tests/discordMintFlow.test.js.

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
    updates: [], replies: [], modal: null, messageEdits: [], deferred: false, deferredMode: null,
    message: { edit(payload) { state.messageEdits.push(payload); return Promise.resolve(); } },
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(payload) { this.updates.push(payload); },
    async reply(payload) { this.replies.push(payload); },
    async showModal(payload) { this.modal = payload; },
    // A deferred component interaction can only be answered via editReply() -- deferUpdate() edits
    // the original message in place (same visual effect as update()), deferReply() posts/edits a
    // fresh reply (same as reply()), so editReply() routes to whichever array matches what the real
    // Discord client would actually show, keeping every existing .updates[0]/.replies[0] assertion
    // valid for handlers that now defer before their slow work (flow:taskconfirm, schedulesuggest).
    async deferUpdate() { this.deferred = true; this.deferredMode = 'update'; },
    async deferReply(options) { this.deferred = true; this.deferredMode = 'reply'; this.deferOptions = options; },
    async editReply(payload) { (this.deferredMode === 'update' ? this.updates : this.replies).push(payload); },
    // Always posts an additional message, regardless of deferredMode -- the public-origin-message
    // -> ephemeral transition uses this now that handleComponent defers every tap up front (see
    // willShowModal in discordBot.js).
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
const NO_LIMIT = { check: () => {} };
const FUTURE_START = Math.floor(Date.now() / 1000) + 3_600;
const FUTURE_ISO = new Date(FUTURE_START * 1000).toISOString();

function baseCommands(overrides = {}) {
  return {
    parseOpenSeaCollectionSlug: () => null,
    resolveMintContractInput: async input => (/^0x[0-9a-fA-F]{40}$/.test(input) ? input : null),
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: true, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 100, maxPerWallet: 1, startTime: FUTURE_START, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
    wallets: () => [{ label: 'main', chain: 'ethereum' }],
    createTask: async () => ({ name: 'GTD', mintTime: FUTURE_ISO }),
    ...overrides,
  };
}

async function pasteAndTapSchedule(ctx, userId = 'paster') {
  const message = mockMessage('0x0000000000000000000000000000000000000001', userId);
  await handleMintPasteMessage(ctx, message);
  const handler = createDiscordInteractionHandler(ctx);
  const tap = buttonInteraction('flow:schedulesuggest', userId);
  await handler(tap);
  return { message, handler, tap };
}

test('a single wallet is auto-selected: tapping Schedule for opening goes straight to naming', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { message, tap } = await pasteAndTapSchedule(ctx, 'paster-1');
  assert.match(message.replies[0].content, /Opens:/);
  assert.equal(tap.messageEdits.length, 1, 'the public origin message must be neutralized on first touch');
  assert.equal(tap.replies.length, 1);
  // The public-origin-message -> ephemeral transition posts via followUp({ephemeral:true}), not a
  // fresh reply() -- handleComponent's own blanket up-front defer (see willShowModal in
  // discordBot.js) already acknowledged this interaction before flow:schedulesuggest's handler
  // even started its live re-detection.
  assert.equal(tap.deferred, true);
  assert.equal(tap.replies[0].ephemeral, true);
  const options = tap.replies[0].components[0].components[0].options;
  assert.deepEqual(options.map(o => o.value), ['GTD', 'FCFS', 'PUBLIC', 'custom']);
  assert.equal(flowState.get('discord', 'paster-1').flow, 'task_guided');
  assert.equal(flowState.get('discord', 'paster-1').step, 'awaiting_name');
  assert.equal(flowState.get('discord', 'paster-1').data.walletLabel, 'main');
});

test('maxPerWallet > 1 asks for a quantity before naming, and the chosen amount reaches createTask', async () => {
  const flowState = createFlowStateStore();
  const created = [];
  const commands = baseCommands({
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: true, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 100, maxPerWallet: 5, startTime: FUTURE_START, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
    createTask: async (userId, input) => { created.push({ userId, input }); return { name: input.name, mintTime: input.mintTime }; },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-qty');
  assert.equal(flowState.get('discord', 'paster-qty').step, 'awaiting_quantity');

  const qtySelect = selectInteraction('flow:mintqty:select', ['3'], 'paster-qty');
  await handler(qtySelect);
  assert.equal(flowState.get('discord', 'paster-qty').step, 'awaiting_name', 'single wallet auto-selects and moves straight to naming');
  assert.equal(flowState.get('discord', 'paster-qty').data.quantity, 3);

  await handler(selectInteraction('flow:taskname:select', ['GTD'], 'paster-qty'));
  const confirm = buttonInteraction('flow:taskconfirm', 'paster-qty');
  await handler(confirm);
  assert.equal(created[0].input.quantity, 3);
});

test('typing a custom quantity via the modal advances to the wallet picker when there is more than one wallet', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({
    wallets: () => [{ label: 'alpha', chain: 'ethereum' }, { label: 'beta', chain: 'ethereum' }],
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: true, priceKnown: true, valueWei: '1000000000000000000',
      maxSupply: 100, maxPerWallet: 5, startTime: FUTURE_START, endTime: null, collection: null, soldOut: false, displayPrice: null,
    }),
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-custom-qty');
  const custom = selectInteraction('flow:mintqty:select', ['custom'], 'paster-custom-qty');
  await handler(custom);
  assert.equal(custom.modal.custom_id, 'flow:mintqty:submit');

  const submit = modalInteraction('flow:mintqty:submit', { value: '4' }, 'paster-custom-qty');
  await handler(submit);
  assert.equal(submit.replies[0].ephemeral, true);
  const flow = flowState.get('discord', 'paster-custom-qty');
  assert.equal(flow.step, 'awaiting_wallet');
  assert.equal(flow.data.quantity, 4);
});

test('more than one wallet shows a wallet select before naming', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands({ wallets: () => [{ label: 'alpha', chain: 'ethereum' }, { label: 'beta', chain: 'ethereum' }] });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { tap, handler } = await pasteAndTapSchedule(ctx, 'paster-2');
  assert.equal(flowState.get('discord', 'paster-2').step, 'awaiting_wallet');
  const walletOptions = tap.replies[0].components[0].components[0].options;
  assert.deepEqual(walletOptions.map(o => o.value), ['alpha', 'beta']);

  const pick = selectInteraction('flow:taskwallet:select', ['beta'], 'paster-2');
  await handler(pick);
  assert.equal(pick.updates.length, 1, 'already ephemeral by this point -- updates in place');
  assert.equal(flowState.get('discord', 'paster-2').step, 'awaiting_name');
  assert.equal(flowState.get('discord', 'paster-2').data.walletLabel, 'beta');
});

test('full happy path: schedule suggestion -> name quick-pick -> confirm -> task created and flow cleared', async () => {
  const flowState = createFlowStateStore();
  const created = [];
  const commands = baseCommands({
    createTask: async (userId, input) => { created.push({ userId, input }); return { name: input.name, mintTime: input.mintTime }; },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-3');

  const namePick = selectInteraction('flow:taskname:select', ['GTD'], 'paster-3');
  await handler(namePick);
  assert.equal(namePick.updates.length, 1);
  assert.match(namePick.updates[0].content, /Confirm scheduled mint/);
  assert.match(namePick.updates[0].content, /GTD/);
  assert.match(namePick.updates[0].content, /not a reminder/);
  assert.equal(flowState.get('discord', 'paster-3').step, 'awaiting_confirm');

  const confirm = buttonInteraction('flow:taskconfirm', 'paster-3');
  await handler(confirm);
  assert.equal(created.length, 1);
  assert.equal(created[0].userId, 'internal-user');
  assert.equal(created[0].input.name, 'GTD');
  assert.equal(created[0].input.walletLabel, 'main');
  assert.equal(created[0].input.contractAddress, '0x0000000000000000000000000000000000000001');
  assert.equal(created[0].input.mintTime, FUTURE_ISO);
  assert.equal(created[0].input.priceETH, 1);
  assert.match(confirm.updates[0].content, /Scheduled/);
  assert.equal(flowState.get('discord', 'paster-3'), null);
});

// Section AF -- a phase that hasn't opened yet has nothing to mint against, so there's no
// eligibility to pre-check (see mintViaOpenSea's own notes); being scheduled and ready right at
// open is what actually cuts the wasted time this feature exists for.
function withNextStage(overrides = {}) {
  const nextStage = { uuid: 'n1', label: 'Allowlist', startTime: FUTURE_START, endTime: FUTURE_START + 3600, priceETH: 0.05, maxPerWallet: 1, stageType: 'presale' };
  return baseCommands({
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: true, priceKnown: false, valueWei: '0',
      maxSupply: 100, maxPerWallet: 1, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
      // A real OpenSea response always has nextStage as one of the entries in stages too (its own
      // convenience pointer into that same list) -- an empty stages array here would be unrealistic
      // and, since the schedule-via-OpenSea decision is driven by stages now, would wrongly read as
      // "nothing schedulable" instead of "exactly one schedulable stage."
      drop: { isMinting: false, dropType: 'seadrop_v1_erc721', maxSupply: 100, openSeaUrl: null,
        activeStage: null, nextStage, stages: [nextStage] },
    }),
    ...overrides,
  });
}

test('flow:scheduleviaopensea pre-fills the next stage\'s own opening time and skips straight to naming for a single wallet', async () => {
  const flowState = createFlowStateStore();
  const created = [];
  const commands = withNextStage({
    createTask: async (userId, input) => { created.push({ userId, input }); return { name: input.name, mintTime: input.mintTime, viaOpenSea: input.viaOpenSea }; },
  });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const message = mockMessage('0x0000000000000000000000000000000000000001', 'osea-sched-1');
  await handleMintPasteMessage(ctx, message);
  const handler = createDiscordInteractionHandler(ctx);
  const tap = buttonInteraction('flow:scheduleviaopensea', 'osea-sched-1');
  await handler(tap);
  assert.equal(flowState.get('discord', 'osea-sched-1').flow, 'task_guided');
  assert.equal(flowState.get('discord', 'osea-sched-1').step, 'awaiting_name');
  assert.equal(flowState.get('discord', 'osea-sched-1').data.mintTime, FUTURE_ISO);
  assert.equal(flowState.get('discord', 'osea-sched-1').data.viaOpenSea, true);
  // No price step reached at all -- OpenSea determines the real price, never anything asked here.
  assert.notEqual(flowState.get('discord', 'osea-sched-1').step, 'awaiting_price');

  await handler(selectInteraction('flow:taskname:select', ['GTD'], 'osea-sched-1'));
  const confirm = buttonInteraction('flow:taskconfirm', 'osea-sched-1');
  await handler(confirm);
  assert.equal(created.length, 1);
  assert.equal(created[0].input.viaOpenSea, true);
  assert.equal(created[0].input.mintTime, FUTURE_ISO);
  assert.match(confirm.updates[0].content, /Scheduled/);
  assert.match(confirm.updates[0].content, /via OpenSea/);
});

test('flow:scheduleviaopensea is a no-op when the card has no upcoming OpenSea stage, instead of scheduling against nothing', async () => {
  const flowState = createFlowStateStore();
  const created = [];
  const commands = baseCommands({ createTask: async (userId, input) => { created.push({ userId, input }); return {}; } });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const message = mockMessage('0x0000000000000000000000000000000000000001', 'osea-sched-2');
  await handleMintPasteMessage(ctx, message);
  const handler = createDiscordInteractionHandler(ctx);
  const tap = buttonInteraction('flow:scheduleviaopensea', 'osea-sched-2');
  await handler(tap);
  assert.equal(created.length, 0);
});

// Round 22: a drop with more than one upcoming stage can't schedule "the next one" blindly anymore
// -- flow:scheduleviaopensea shows a picker, and the chosen stage (not necessarily the earliest)
// drives what actually gets scheduled.
function withTwoUpcomingStages(overrides = {}) {
  const earlier = { uuid: 'e1', label: 'Allowlist', startTime: FUTURE_START, endTime: FUTURE_START + 3600, priceETH: 0.05, maxPerWallet: 1, stageType: 'presale' };
  const later = { uuid: 'l1', label: 'Late FCFS', startTime: FUTURE_START + 90_000, endTime: FUTURE_START + 180_000, priceETH: 0.08, maxPerWallet: 3, stageType: 'fcfs' };
  return baseCommands({
    detectMintContract: async () => ({
      chain: 'ethereum', isSeaDrop: true, priceKnown: false, valueWei: '0',
      maxSupply: 100, maxPerWallet: 1, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
      drop: { isMinting: false, dropType: 'seadrop_v1_erc721', maxSupply: 100, openSeaUrl: null,
        activeStage: null, nextStage: earlier, stages: [earlier, later] },
    }),
    ...overrides,
  });
}

test('flow:scheduleviaopensea shows a picker with more than one upcoming stage, and picking the LATER one schedules against that, not the earlier default', async () => {
  const flowState = createFlowStateStore();
  const created = [];
  const commands = withTwoUpcomingStages({ createTask: async (userId, input) => { created.push({ userId, input }); return { name: input.name, mintTime: input.mintTime, viaOpenSea: input.viaOpenSea }; } });
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const message = mockMessage('0x0000000000000000000000000000000000000001', 'osea-pick-1');
  await handleMintPasteMessage(ctx, message);
  const handler = createDiscordInteractionHandler(ctx);
  const tap = buttonInteraction('flow:scheduleviaopensea', 'osea-pick-1');
  await handler(tap);
  assert.equal(flowState.get('discord', 'osea-pick-1').flow, 'mint_guided');
  assert.equal(flowState.get('discord', 'osea-pick-1').step, 'awaiting_phase_pick');
  const options = tap.replies[0].components[0].components[0].options;
  assert.equal(options.length, 2);

  const pick = selectInteraction('flow:scheduleviaopenseaphase:select', ['1'], 'osea-pick-1');
  await handler(pick);
  assert.equal(flowState.get('discord', 'osea-pick-1').flow, 'task_guided');
  assert.equal(flowState.get('discord', 'osea-pick-1').step, 'awaiting_name');
  assert.equal(flowState.get('discord', 'osea-pick-1').data.mintTime, new Date((FUTURE_START + 90_000) * 1000).toISOString(),
    'the LATER stage (index 1) was chosen, not index 0');

  await handler(selectInteraction('flow:taskname:select', ['GTD'], 'osea-pick-1'));
  await handler(buttonInteraction('flow:taskconfirm', 'osea-pick-1'));
  assert.equal(created.length, 1);
  assert.equal(created[0].input.mintTime, new Date((FUTURE_START + 90_000) * 1000).toISOString());
});

test('picking "custom" opens a modal; submitting it reaches the same confirm screen', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-4');
  const custom = selectInteraction('flow:taskname:select', ['custom'], 'paster-4');
  await handler(custom);
  assert.equal(custom.modal.custom_id, 'flow:taskname:submit');

  const submit = modalInteraction('flow:taskname:submit', { value: 'FCFS wave 2' }, 'paster-4');
  await handler(submit);
  assert.equal(submit.replies[0].ephemeral, true);
  assert.match(submit.replies[0].content, /Confirm scheduled mint/);
  assert.match(submit.replies[0].content, /FCFS wave 2/);
  assert.equal(flowState.get('discord', 'paster-4').data.name, 'FCFS wave 2');
});

test('an empty or oversized custom name is rejected without advancing the flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-5');
  await handler(selectInteraction('flow:taskname:select', ['custom'], 'paster-5'));
  const submit = modalInteraction('flow:taskname:submit', { value: '' }, 'paster-5');
  await handler(submit);
  assert.match(submit.replies[0].content, /1-100 characters/);
  assert.equal(flowState.get('discord', 'paster-5').step, 'awaiting_name');
});

test('a rate limit on confirm keeps the flow intact instead of discarding it', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const rateLimiter = { check: () => { throw new RateLimitError(5000); } };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter };

  const { handler } = await pasteAndTapSchedule(ctx, 'paster-6');
  await handler(selectInteraction('flow:taskname:select', ['GTD'], 'paster-6'));
  const confirm = buttonInteraction('flow:taskconfirm', 'paster-6');
  await handler(confirm);
  assert.match(confirm.updates[0].content, /Too many sensitive commands/);
  assert.equal(flowState.get('discord', 'paster-6').flow, 'task_guided');
});

test('a transient re-detection failure degrades to a retry message instead of crashing the flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-7');
  await handleMintPasteMessage({ identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);

  const failingCommands = { ...commands, detectMintContract: async () => { throw new Error('rpc down'); } };
  const handler = createDiscordInteractionHandler({ identity, commands: failingCommands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT });
  const tap = buttonInteraction('flow:schedulesuggest', 'paster-7');
  await handler(tap);
  assert.match(tap.replies[0].content, /Could not re-check/);
  assert.equal(flowState.get('discord', 'paster-7').flow, 'mint_guided', 'the original mint flow is left in place, not silently cleared');
});

test('re-detecting a contract that has since gone live degrades to a clear message instead of scheduling a stale time', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'paster-8');
  await handleMintPasteMessage({ identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT }, message);

  // The card's own flow.data still shows the original future startTime (that guard passes) --
  // this exercises the re-detect inside the handler finding the stage has gone live since.
  const wentLiveCommands = { ...commands, detectMintContract: async () => ({ ...(await commands.detectMintContract()), startTime: Math.floor(Date.now() / 1000) - 60 }) };
  const handler = createDiscordInteractionHandler({ identity, commands: wentLiveCommands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT });
  const tap = buttonInteraction('flow:schedulesuggest', 'paster-8');
  await handler(tap);
  assert.match(tap.replies[0].content, /couldn't be confirmed/);
  assert.equal(flowState.get('discord', 'paster-8').flow, 'mint_guided', 'stays on the original mint flow rather than half-starting task_guided');
});

test('a different user\'s click on the flow\'s public message is rejected ephemerally and never touches the original flow', async () => {
  const flowState = createFlowStateStore();
  const commands = baseCommands();
  const identity = { resolveOrCreate: async () => 'internal-user' };
  const ctx = { identity, commands, flowState, chains: CHAINS, rateLimiter: NO_LIMIT };
  const message = mockMessage('0x0000000000000000000000000000000000000001', 'owner-1');
  await handleMintPasteMessage(ctx, message);

  const handler = createDiscordInteractionHandler(ctx);
  const strangerTap = buttonInteraction('flow:schedulesuggest', 'stranger-1');
  await handler(strangerTap);
  assert.match(strangerTap.replies[0].content, /isn't your mint prompt/);
  assert.equal(strangerTap.messageEdits.length, 0, 'a stranger\'s click must not neutralize the owner\'s message');

  const ownerTap = buttonInteraction('flow:schedulesuggest', 'owner-1');
  await handler(ownerTap);
  assert.equal(ownerTap.messageEdits.length, 1, 'the real owner can still continue normally afterward');
});
