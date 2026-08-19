const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');

// Section O -- Discord's menu:mint/menu:activity/menu:gas/menu:tasks/menu:snipers/menu:admin
// buttons used to just reply "use /mint" etc instead of performing the action; this file now
// covers all six, closing out Discord's side of Section O (only menu:admin has no single "the"
// read to mirror -- it surfaces governance.dashboardOverview instead, see adminOverviewFormat.js).
// Mirrors the mock shape established by tests/discordWalletFlow.test.js.

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
    // deferReply -> a fresh reply, i.e. replies).
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

function modalInteraction(customId, fields, userId = 'discord-user') {
  const i = baseInteraction(userId);
  i.customId = customId;
  i.isModalSubmit = () => true;
  i.fields = { getTextInputValue: name => fields[name] };
  return i;
}

const CHAINS = { ethereum: { name: 'Ethereum', sym: 'ETH' }, base: { name: 'Base', sym: 'ETH' } };

function fixture(overrides = {}) {
  const handler = createDiscordInteractionHandler({
    identity: { resolveOrCreate: async () => 'internal-user' },
    chains: CHAINS,
    supportedChains: ['ethereum', 'base'],
    commands: {
      gas: async chain => ({ chain, safeGasPriceGwei: 10, gasPriceGwei: 12, maxFeePerGasGwei: 20 }),
      activityPage: async (userId, { page }) => ({ page, totalPages: 2, total: 3,
        items: page === 1 ? [{ status: 'success', title: 'Cool Cats', walletLabel: 'main' }] : [{ status: 'fail', title: 'Bad Apes', walletLabel: 'main' }] }),
      tasksPage: async (userId, { page }) => ({ page, totalPages: 2, total: 3,
        items: page === 1 ? [{ name: 'GTD', status: 'scheduled', mintTime: '2026-08-20T18:00:00.000Z', id: 'task-1' }] : [{ name: 'FCFS', status: 'scheduled', mintTime: '2026-08-20T19:00:00.000Z', id: 'task-2' }] }),
      snipers: () => [{ label: 'Copy Cool Cats', active: true, id: 'sniper-1' }],
      adminOverview: async () => ({
        metrics: { totalUsers: 10, activeAnyPlatform24h: 4, owners: 2, rootOwners: 1, groups: 1, linkedAccounts: 6 },
        groups: [{ name: 'Standard', gasCeilingGwei: 50, maxTransactionValueWei: '500000000000000000', dailySpendingBudgetWei: '2000000000000000000' }],
      }),
      parseOpenSeaCollectionSlug: () => null,
      resolveMintContractInput: async input => (/^0x[0-9a-fA-F]{40}$/.test(input) ? input : null),
      detectMintContract: async () => ({
        chain: 'ethereum', isSeaDrop: false, priceKnown: true, valueWei: '1000000000000000000',
        maxSupply: 100, maxPerWallet: 1, startTime: null, endTime: null, collection: null, soldOut: false, displayPrice: null,
      }),
      wallets: () => [{ label: 'main-wallet', address: '0xed9834A3E62c8eB78B7F6682c5798f69B4Ee2976', chain: 'ethereum', minted: 3 }],
      ...overrides.commands,
    },
  });
  return { handler };
}

test('menu:gas performs the lookup directly and defaults to ethereum, with a way to switch chains', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:gas');
  await handler(tap);
  assert.match(tap.updates[0].content, /Gas check: Ethereum/);
  assert.match(tap.updates[0].content, /Standard.*12.*Gwei/s);
  const chainButtons = tap.updates[0].components[0].components.map(b => b.custom_id);
  assert.deepEqual(chainButtons, ['gas:chain:ethereum', 'gas:chain:base']);
});

test('gas:chain:base switches to the tapped chain, calling the same commands.gas the /gas command uses', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('gas:chain:base');
  await handler(tap);
  assert.match(tap.updates[0].content, /Gas check: Base/);
});

test('menu:gas degrades to "unavailable" instead of a generic failure when the lookup rejects', async () => {
  const { handler } = fixture({ commands: { gas: async () => { throw new Error('rpc down'); } } });
  const tap = buttonInteraction('menu:gas');
  await handler(tap);
  assert.match(tap.updates[0].content, /Couldn't fetch gas prices/);
});

test('menu:activity shows page 1 directly, the same botCommands.activityPage() call /activity uses', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:activity');
  await handler(tap);
  assert.match(tap.updates[0].content, /page 1\/2/);
  assert.match(tap.updates[0].content, /Cool Cats/);
  const nextButton = tap.updates[0].components[0].components.find(b => b.custom_id === 'activity:page:2');
  assert.ok(nextButton, 'a Next button must be offered when more pages exist');
});

test('activity:page:2 pages forward and offers Prev but not Next once on the last page', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('activity:page:2');
  await handler(tap);
  assert.match(tap.updates[0].content, /page 2\/2/);
  assert.match(tap.updates[0].content, /Bad Apes/);
  const customIds = tap.updates[0].components[0].components.map(b => b.custom_id);
  assert.deepEqual(customIds, ['activity:page:1']);
});

test('menu:mint opens a modal for the contract address instead of replying "use /mint"', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:mint');
  await handler(tap);
  assert.equal(tap.modal.custom_id, 'menu:mint:submit');
});

test('submitting menu:mint:submit with a valid contract reaches the same collection card /mint and pasting already use', async () => {
  const { handler } = fixture();
  const submit = modalInteraction('menu:mint:submit', { value: '0x0000000000000000000000000000000000000001' });
  await handler(submit);
  assert.equal(submit.replies[0].ephemeral, true);
  assert.match(submit.replies[0].content, /Contract details|SeaDrop|Standard mint/);
});

test('submitting menu:mint:submit with an unresolvable contract says so instead of silently doing nothing', async () => {
  const { handler } = fixture({ commands: { resolveMintContractInput: async () => null } });
  const submit = modalInteraction('menu:mint:submit', { value: 'not-a-contract' });
  await handler(submit);
  assert.match(submit.replies[0].content, /Could not find this contract/);
});

test('menu:tasks performs the same lookup /task list uses instead of replying "use /task"', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:tasks');
  await handler(tap);
  assert.match(tap.updates[0].content, /GTD.*scheduled/);
  const buttons = tap.updates[0].components.flatMap(r => r.components).map(b => b.custom_id);
  assert.ok(buttons.includes('tasks:page:2'));
});

test('tasks:page:2 pages forward through the same tasksPage call', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('tasks:page:2');
  await handler(tap);
  assert.match(tap.updates[0].content, /FCFS.*scheduled/);
});

test('menu:snipers performs the same lookup /sniper list uses instead of replying "use /sniper"', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:snipers');
  await handler(tap);
  assert.match(tap.updates[0].content, /Post-confirmation copying only/);
  assert.match(tap.updates[0].content, /Copy Cool Cats/);
});

test('menu:admin shows the real governance overview instead of replying "use /admin"', async () => {
  const { handler } = fixture();
  const tap = buttonInteraction('menu:admin');
  await handler(tap);
  assert.match(tap.updates[0].content, /10 total/);
  assert.match(tap.updates[0].content, /Standard.*gas ≤50 gwei/);
});

test('menu:admin surfaces "Owner access required" for a non-owner instead of a raw error, same as /admin', async () => {
  const { AuthorizationError } = require('../src/governance/governanceService');
  const { handler } = fixture({ commands: { adminOverview: async () => { throw new AuthorizationError(); } } });
  const tap = buttonInteraction('menu:admin');
  await handler(tap);
  assert.equal(tap.updates[0].content, 'Owner access required.');
});

test('the Discord wallet list renders readable markdown, not an escaped wall of slashes', async () => {
  // escapeDiscord() was applied to the FINISHED string, so it escaped the markdown the message is
  // assembled from: the code-fence backticks became literal and every . - ( ) picked up a
  // backslash, and the list arrived as slashes rather than as wallets. Only the label is
  // user-controlled, so only the label needs escaping.
  const { handler } = fixture();
  const tap = buttonInteraction('wallet:list');
  await handler(tap);
  const payload = [...tap.updates, ...tap.replies].pop();
  assert.ok(payload, 'the tap must be answered at all');
  const content = String(payload.content);
  assert.ok(content.includes('**Wallets (1)**'), 'header renders as bold markdown, not escaped');
  assert.ok(content.includes('`0xed98...2976`'), 'the address keeps its code formatting');
  const BS = String.fromCharCode(92);
  assert.equal(content.includes(BS + '('), false, 'no escaped parentheses');
  assert.equal(content.includes(BS + '.'), false, 'no escaped full stops');
  assert.ok(content.includes('main' + BS + '-wallet'), 'the user-controlled label IS still escaped');
});
