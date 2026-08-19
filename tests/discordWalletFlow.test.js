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
  assert.match(select.editReplies[0].content, /\*\*main\*\*/);
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

test('wallet:balance:pick still responds immediately (no defer needed -- just renders the picker)', async () => {
  const { handler } = fixture();
  const pick = buttonInteraction('wallet:balance:pick');
  await handler(pick);
  assert.equal(pick.deferred, false);
  assert.equal(pick.updates.length, 1);
});
