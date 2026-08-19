const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');

// Mirrors the mock shape used in tests/discordBot.test.js, but for message-component (button,
// select menu) and modal-submit interactions, which is what Milestone 15c's guided menu UX adds
// on top of the already-tested slash commands.

function baseInteraction(userId) {
  const state = {
    user: { id: userId }, guildId: 'guild', channelId: 'channel',
    updates: [], replies: [], modal: null, deferred: false, replied: false, deferredMode: null,
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(payload) { this.updates.push(payload); },
    async reply(payload) { this.replied = true; this.replies.push(payload); },
    async showModal(payload) { this.modal = payload; },
    // handleComponent defers every tap up front except the ones reserved for showModal (see
    // willShowModal in discordBot.js) -- editReply() routes to whichever array matches what the
    // real Discord client would show (deferUpdate -> the original message, i.e. updates;
    // deferReply -> a fresh reply, i.e. replies), and followUp() always posts an additional
    // ephemeral message for the public-origin-message-to-ephemeral transition.
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

test('the /menu command shows the main menu and gates the admin button on ownership', async () => {
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' }, commands: {}, isOwner: async () => true,
  });
  const input = chatInteraction('menu');
  await handler(input);
  assert.match(input.replies[0].content, /GhostMint/);
  const hasAdmin = input.replies[0].components.some(row => row.components.some(c => c.custom_id === 'menu:admin'));
  assert.equal(hasAdmin, true);
});

test('clicking Wallets edits the message in place with the wallets submenu', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {} });
  const btn = buttonInteraction('menu:wallets');
  await handler(btn);
  // Deferred via deferUpdate() (edits the original message), then answered via editReply() -- the
  // same eventual visual effect as a bare update() would have had, just acknowledged up front.
  assert.equal(btn.deferred, true);
  assert.equal(btn.updates.length, 1);
  assert.match(btn.updates[0].content, /Wallets/);
});

// The real bug this guards against: "GHOST_1.0 didn't respond in time" was seen even on
// menu:wallets, which does no RPC/DB work of its own -- identity.resolveOrCreate (a DB round trip
// every handler runs before its own branch) was apparently slow enough on its own, some of the
// time, to occasionally blow Discord's 3s component-ack window. handleComponent now defers every
// tap unconditionally, before identity resolution even runs, rather than only deferring the
// specific handlers already known to do slow work.
test('every ordinary button defers before identity resolution runs, not after', async () => {
  const order = [];
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => { order.push('resolve'); return 'user-a'; } },
    commands: {},
  });
  const btn = buttonInteraction('menu:wallets');
  const originalDefer = btn.deferUpdate.bind(btn);
  btn.deferUpdate = async () => { order.push('defer'); return originalDefer(); };
  await handler(btn);
  assert.deepEqual(order, ['defer', 'resolve']);
});

// showModal() is mutually exclusive with defer/reply -- a handler that opens a modal must never
// have been pre-deferred, or Discord rejects the modal call as "already acknowledged".
test('a button that opens a modal is never pre-deferred', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {} });
  // menu:mint now asks single-or-batch first, so the modal openers are its two answers. The
  // invariant is unchanged and still worth guarding: whatever opens a modal must not be deferred,
  // because a deferred interaction can no longer show one.
  for (const [id, expected] of [['menu:mint:single', 'menu:mint:submit'], ['menu:mint:batch', 'menu:mint:batch:submit']]) {
    const btn = buttonInteraction(id);
    await handler(btn);
    assert.equal(btn.deferred, false, `${id} must not be pre-deferred`);
    assert.equal(btn.modal.custom_id, expected);
  }
});

test('the create-wallet button starts a guided flow and shows a label modal', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {} });
  const btn = buttonInteraction('wallet:create:start', 'flow-user-1');
  await handler(btn);
  assert.equal(btn.modal.custom_id, 'flow:label:submit');
});

test('submitting the label modal advances the flow to chain selection', async () => {
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'user-a' }, commands: {},
    supportedChains: ['ethereum'], chains: { ethereum: { name: 'Ethereum' } },
  });
  await handler(buttonInteraction('wallet:create:start', 'flow-user-2'));
  const modal = modalInteraction('flow:label:submit', { value: 'my-wallet' }, 'flow-user-2');
  await handler(modal);
  assert.equal(modal.replies.length, 1);
  assert.match(modal.replies[0].content, /Choose a chain/);
});

test('selecting a chain completes wallet creation through the shared botCommandService and clears the flow', async () => {
  const created = [];
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user' },
    commands: { createWallet: async (userId, input) => { created.push({ userId, input }); return { label: input.label, address: '0xabc', chain: input.chain }; } },
    supportedChains: ['ethereum'], chains: { ethereum: { name: 'Ethereum' } },
  });
  await handler(buttonInteraction('wallet:create:start', 'flow-user-3'));
  await handler(modalInteraction('flow:label:submit', { value: 'main' }, 'flow-user-3'));
  const select = selectInteraction('flow:chain:select', ['ethereum'], 'flow-user-3');
  await handler(select);
  assert.deepEqual(created[0], { userId: 'internal-user', input: { label: 'main', chain: 'ethereum' } });
  assert.match(select.updates[0].content, /generated securely/);

  // the flow must be fully cleared: a later divergent click should not think a flow is active
  // (menu:wallets, not menu:mint/menu:tasks, since Section O now makes both of those perform a
  // real action requiring their own command mocks -- this probe just needs any other menu tap
  // that still renders a static, no-data-fetch screen)
  const after = buttonInteraction('menu:wallets', 'flow-user-3');
  await handler(after);
  assert.match(after.updates[0].content, /Wallets/);
});

test('navigating to a different menu mid-flow silently abandons it and switches immediately, no confirmation', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'internal-user' }, commands: {} });
  await handler(buttonInteraction('wallet:create:start', 'flow-user-4'));
  const divert = buttonInteraction('menu:wallets', 'flow-user-4');
  await handler(divert);
  assert.match(divert.updates[0].content, /Wallets/);

  // the abandoned flow must actually be gone -- a follow-up tap that only makes sense mid-wallet-
  // creation (submitting the label modal) must not still be honored.
  const stray = modalInteraction('flow:label:submit', { value: 'late' }, 'flow-user-4');
  await handler(stray);
  assert.match(stray.replies[0].content, /expired/);
});

test('a slash command issued mid-flow silently abandons the flow and runs normally, no confirmation', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'internal-user' }, commands: {} });
  await handler(buttonInteraction('wallet:create:start', 'flow-user-7'));
  const slash = chatInteraction('menu', 'flow-user-7');
  await handler(slash);
  assert.equal(slash.deferred, true, 'the command actually ran (deferred+replied), not intercepted');
  assert.match(slash.replies[0].content, /GhostMint/);

  const stray = modalInteraction('flow:label:submit', { value: 'late' }, 'flow-user-7');
  await handler(stray);
  assert.match(stray.replies[0].content, /expired/);
});

test('the remove-wallet select flow requires an explicit confirmation before permanently removing it', async () => {
  let removed = null;
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user' },
    commands: { wallets: () => [{ label: 'cold', chain: 'ethereum' }], removeWallet: async (userId, label) => { removed = label; } },
  });
  await handler(buttonInteraction('wallet:remove:pick', 'flow-user-8'));
  const select = selectInteraction('wallet:remove:select', ['cold'], 'flow-user-8');
  await handler(select);
  assert.match(select.updates[0].content, /Remove wallet cold\?/);
  assert.equal(removed, null);
  const confirm = buttonInteraction('wallet:remove:do:cold', 'flow-user-8');
  await handler(confirm);
  assert.equal(removed, 'cold');
  assert.match(confirm.updates[0].content, /removed/);
});

test('an invalid label surfaces the validation message and lets the user retry from the wallets menu', async () => {
  const { ValidationError } = require('../src/validation/domain');
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user' },
    commands: { createWallet: async () => { throw new ValidationError({ field: 'label', message: 'must be unique' }); } },
    supportedChains: ['ethereum'], chains: { ethereum: { name: 'Ethereum' } },
  });
  await handler(buttonInteraction('wallet:create:start', 'flow-user-9'));
  await handler(modalInteraction('flow:label:submit', { value: 'dup' }, 'flow-user-9'));
  const select = selectInteraction('flow:chain:select', ['ethereum'], 'flow-user-9');
  await handler(select);
  assert.match(select.updates[0].content, /must be unique/);

  // the flow was cleared on failure, so the user is free to start over without a stale cancel prompt
  const retry = buttonInteraction('wallet:create:start', 'flow-user-9');
  await handler(retry);
  assert.equal(retry.modal.custom_id, 'flow:label:submit');
});

test('each createDiscordInteractionHandler call gets its own isolated flow store by default', async () => {
  const handlerA = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {} });
  const handlerB = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-b' }, commands: {} });
  await handlerA(buttonInteraction('wallet:create:start', 'shared-id'));
  // handler B has never seen this user before, so a menu click must not be treated as a diverging flow
  const clickOnB = buttonInteraction('menu:wallets', 'shared-id');
  await handlerB(clickOnB);
  assert.match(clickOnB.updates[0].content, /Wallets/);
});

test('createDiscordInteractionHandler accepts an injected flow store for tests that need to share one explicitly', async () => {
  const flowState = createFlowStateStore();
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {}, flowState });
  await handler(buttonInteraction('wallet:create:start', 'injected-user'));
  assert.ok(flowState.get('discord', 'injected-user'));
});

test('the Settings link button opens a code-entry modal instead of generating a code', async () => {
  let generated = false;
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user', createLinkCode: async () => { generated = true; return { code: 'should-not-happen' }; } },
    commands: {},
  });
  const btn = buttonInteraction('link:enter', 'link-user-1');
  await handler(btn);
  assert.equal(generated, false);
  assert.equal(btn.modal.custom_id, 'link:code:submit');
});

test('submitting the link-code modal consumes the code without auto-creating an identity first', async () => {
  const seen = [];
  const handler = createDiscordInteractionHandler({
    identity: {
      resolveOrCreate: async () => { throw new Error('must not resolve/create an identity before consuming a link code'); },
      consumeLinkCode: async input => { seen.push(input); return 'telegram-user-id'; },
    },
    commands: {},
  });
  const modal = modalInteraction('link:code:submit', { value: 'ABC123' }, 'link-user-2');
  await handler(modal);
  assert.deepEqual(seen, [{ code: 'ABC123', platform: 'discord', platformUserId: 'link-user-2' }]);
  assert.match(modal.replies[0].content, /linked.*telegram-user-id/i);
});

test('an invalid or expired link code surfaces a clear message instead of a generic failure', async () => {
  const { LinkCodeError } = require('../src/identity/identityService');
  const handler = createDiscordInteractionHandler({
    identity: { consumeLinkCode: async () => { throw new LinkCodeError('Link code is invalid, expired, or already used.'); } },
    commands: {},
  });
  const modal = modalInteraction('link:code:submit', { value: 'expired' }, 'link-user-3');
  await handler(modal);
  assert.match(modal.replies[0].content, /invalid, expired, or already used/i);
});

// ── Milestone 16a: account status enforcement ──

test('a banned account cannot run a slash command and sees a clear reason, not a generic failure', async () => {
  const { AccountBlockedError } = require('../src/governance/governanceService');
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'blocked-user' },
    checkAccountStatus: async () => { throw new AccountBlockedError('banned', 'spamming other users'); },
    commands: { wallets: () => { throw new Error('must never reach a command handler once blocked'); } },
  });
  const slash = chatInteraction('wallet', 'blocked-user-1');
  await handler(slash);
  assert.match(slash.replies[0], /banned.*spamming other users/i);
});

test('a suspended account is blocked from button interactions the same way as slash commands', async () => {
  const { AccountBlockedError } = require('../src/governance/governanceService');
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'blocked-user' },
    checkAccountStatus: async () => { throw new AccountBlockedError('suspended', 'cooling off period'); },
    commands: {},
  });
  const btn = buttonInteraction('menu:wallets', 'blocked-user-2');
  await handler(btn);
  assert.match(btn.updates[0].content, /suspended.*cooling off period/i);
});

test('an active (non-blocked) account is unaffected when checkAccountStatus is wired in', async () => {
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'fine-user' },
    checkAccountStatus: async () => {},
    commands: {},
  });
  const btn = buttonInteraction('menu:wallets', 'fine-user-1');
  await handler(btn);
  assert.match(btn.updates[0].content, /Wallets/);
});

test('omitting checkAccountStatus entirely (e.g. in tests that do not care about it) never blocks anyone', async () => {
  const handler = createDiscordInteractionHandler({ identity: { resolveOrCreate: async () => 'user-a' }, commands: {} });
  const btn = buttonInteraction('menu:wallets', 'no-check-user');
  await handler(btn);
  assert.match(btn.updates[0].content, /Wallets/);
});
