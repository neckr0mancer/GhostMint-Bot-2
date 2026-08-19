const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');

// Discord's wallet-menu buttons (menu:wallets and everything under it) had no dedicated coverage
// before this file -- wallet:balance:select in particular ran a multi-chain RPC balance check
// before ever acknowledging the interaction, which is exactly the shape that produces Discord's
// "The application did not respond" error once any one chain's RPC is slow. Mirrors the mock shape
// established by tests/discordWatchFlow.test.js, extended with deferUpdate/editReply since no
// earlier component-interaction test needed a genuinely deferred response before this.

function baseInteraction(userId) {
  const state = {
    user: { id: userId }, guildId: 'guild', channelId: 'channel',
    updates: [], replies: [], deferred: false, editReplies: [],
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(payload) { this.updates.push(payload); },
    async reply(payload) { this.replies.push(payload); },
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { this.editReplies.push(payload); },
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

function fixture(overrides = {}) {
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user' },
    chains: { ethereum: { name: 'Ethereum', sym: 'ETH' }, base: { name: 'Base', sym: 'ETH' } },
    commands: {
      wallets: () => [{ label: 'main', chain: 'ethereum' }],
      walletBalance: async () => ({ label: 'main', balances: [
        { chain: 'ethereum', balance: '1.5', symbol: 'ETH' },
        { chain: 'base', balance: null, symbol: 'ETH' },
      ] }),
      ...overrides.commands,
    },
  });
  return { handler };
}

test('wallet:balance:select defers before the multi-chain balance check, then edits the deferred reply', async () => {
  const { handler } = fixture();
  const select = selectInteraction('wallet:balance:select', ['main']);
  await handler(select);
  assert.equal(select.deferred, true, 'must acknowledge before the slow RPC check, not after it');
  assert.equal(select.updates.length, 0, 'a deferred interaction must never also call update()');
  assert.equal(select.editReplies.length, 1);
  assert.match(select.editReplies[0].content, /## main/);
});

test('wallet:balance:select formats every chain from result.balances, not a nonexistent result.balance field', async () => {
  const { handler } = fixture();
  const select = selectInteraction('wallet:balance:select', ['main']);
  await handler(select);
  const content = select.editReplies[0].content;
  assert.match(content, /Ethereum: 1\.5 ETH/);
  assert.match(content, /Base: unavailable ETH/);
  assert.doesNotMatch(content, /undefined/);
});

test('a slow balance check that eventually rejects still resolves via the deferred edit, not a fresh update', async () => {
  const { handler } = fixture({ commands: { walletBalance: async () => { throw new Error('rpc exploded'); } } });
  const select = selectInteraction('wallet:balance:select', ['main']);
  await handler(select);
  assert.equal(select.deferred, true);
  assert.equal(select.editReplies.length, 1);
  assert.match(select.editReplies[0].content, /failed safely/i);
});

test('wallet:balance:pick still renders the picker promptly, via the same blanket up-front defer every tap now gets', async () => {
  const { handler } = fixture();
  const pick = buttonInteraction('wallet:balance:pick');
  await handler(pick);
  // handleComponent defers every component tap unconditionally now (except the modal-reserved
  // exceptions in willShowModal) -- identity resolution alone was slow enough on its own to
  // occasionally blow Discord's 3s ack window even for taps like this one that do no RPC work,
  // hence the blanket defer rather than only deferring known-slow handlers one at a time.
  assert.equal(pick.deferred, true);
  assert.equal(pick.editReplies.length, 1);
});

test('the Discord batch card reports keys dropped by the 50 cap instead of failing at import time', () => {
  const { batchImportMenu } = require('../src/discord/menus');
  const { LIMITS } = require('../src/validation/domain');
  assert.equal(/ignored/.test(batchImportMenu({ count: 4 }).content), false, 'silent when nothing was dropped');
  const over = batchImportMenu({ count: LIMITS.batchWalletImport, dropped: 2 });
  assert.match(over.content, /2 keys were ignored/);
  const confirm = over.components.flatMap(r => r.components).find(b => b.custom_id === 'wallet:batch-import:confirm');
  assert.notEqual(confirm.disabled, true, 'the keys that fit stay importable');
});

test('the empty batch card disables Import via disabled, not via the emoji slot', () => {
  // button()'s 4th parameter is emoji; passing the disabled flag there set emoji:true, which
  // Discord rejects for the whole component payload -- and left the button live with nothing to
  // import. Guards both halves.
  const { batchImportMenu } = require('../src/discord/menus');
  const find = card => card.components.flatMap(r => r.components).find(b => b.custom_id === 'wallet:batch-import:confirm');
  const empty = find(batchImportMenu({ count: 0 }));
  assert.equal(empty.disabled, true, 'nothing collected yet, so Import is disabled');
  assert.equal('emoji' in empty, false, 'the disabled flag must not land in the emoji slot');
  assert.equal('emoji' in find(batchImportMenu({ count: 2 })), false);
});
