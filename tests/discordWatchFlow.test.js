const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');
const { ValidationError } = require('../src/validation/domain');

// Watch-rule guided create flow (the "/watch has no button" gap). Mirrors the mock shape and
// coverage bar set by tests/discordFlowUX.test.js and tests/discordMintFlow.test.js. Unlike the
// mint flow, every step here originates from an already-ephemeral message (menu:watch), so there's
// no public-origin-message handling to exercise -- these mocks are the plain discordFlowUX.test.js
// shape, not discordMintFlow.test.js's extended one.

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

function fixture(overrides = {}) {
  const created = [];
  const rules = overrides.rules || [];
  return {
    created,
    rules,
    handler: createDiscordInteractionHandler({
      identity: { resolveOrCreate: async () => 'internal-user' },
      commands: {
        watchRules: async () => rules,
        createWatchRule: async (userId, input) => { const rule = { id: 'rule-1', name: input.name, type: input.type, method: input.method, config: input.config, enabled: true }; created.push({ userId, input }); rules.push(rule); return rule; },
        updateWatchRule: async (userId, id, patch) => { const rule = rules.find(r => r.id === id); Object.assign(rule, patch); return rule; },
        removeWatchRule: async (userId, id) => { const index = rules.findIndex(r => r.id === id); if (index !== -1) rules.splice(index, 1); },
        ...overrides.commands,
      },
    }),
  };
}

test('menu:watch shows an empty-state list with a way to add a rule when there are none yet', async () => {
  const { handler } = fixture();
  const menu = buttonInteraction('menu:watch');
  await handler(menu);
  assert.match(menu.updates[0].content, /No social watch rules yet/);
  assert.ok(menu.updates[0].components.some(row => row.components.some(c => c.custom_id === 'watch:add:start')));
});

test('full happy path (account type): name -> type -> method -> config modal -> confirm creates the rule and clears the flow', async () => {
  const { handler, created } = fixture();

  const start = buttonInteraction('watch:add:start', 'user-1');
  await handler(start);
  assert.equal(start.modal.custom_id, 'flow:watchname:submit');

  const nameSubmit = modalInteraction('flow:watchname:submit', { value: 'Cool Cats watch' }, 'user-1');
  await handler(nameSubmit);
  assert.equal(nameSubmit.replies[0].ephemeral, true);
  assert.match(nameSubmit.replies[0].content, /What do you want to watch/);

  const typeSelect = selectInteraction('flow:watchtype:select', ['twitter_account'], 'user-1');
  await handler(typeSelect);
  assert.match(typeSelect.updates[0].content, /How should this rule get its data/);

  const methodSelect = selectInteraction('flow:watchmethod:select', ['official_api'], 'user-1');
  await handler(methodSelect);
  assert.equal(methodSelect.modal.custom_id, 'flow:watchconfig:submit');
  assert.deepEqual(methodSelect.modal.components.map(row => row.components[0].custom_id), ['handle']);

  const configSubmit = modalInteraction('flow:watchconfig:submit', { handle: '@coolcats' }, 'user-1');
  await handler(configSubmit);
  assert.match(configSubmit.replies[0].content, /Confirm watch rule/);
  assert.match(configSubmit.replies[0].content, /handle: coolcats/);

  const confirm = buttonInteraction('flow:watchconfirm', 'user-1');
  await handler(confirm);
  assert.equal(created.length, 1);
  assert.equal(created[0].userId, 'internal-user');
  assert.deepEqual(created[0].input, { name: 'Cool Cats watch', type: 'twitter_account', method: 'official_api', config: { handle: 'coolcats' } });
  assert.match(confirm.updates[0].content, /created using official_api/);

  // flow cleared: a later confirm tap has nothing to act on
  const stray = buttonInteraction('flow:watchconfirm', 'user-1');
  await handler(stray);
  assert.equal(created.length, 1);
});

test('the scraper method collects the type field and sourceUrl in one modal, not two', async () => {
  const { handler, created } = fixture();
  await handler(buttonInteraction('watch:add:start', 'user-2'));
  await handler(modalInteraction('flow:watchname:submit', { value: 'Keyword watch' }, 'user-2'));
  await handler(selectInteraction('flow:watchtype:select', ['twitter_keyword'], 'user-2'));
  const methodSelect = selectInteraction('flow:watchmethod:select', ['scraper'], 'user-2');
  await handler(methodSelect);
  assert.deepEqual(methodSelect.modal.components.map(row => row.components[0].custom_id), ['keywords', 'sourceUrl']);

  const configSubmit = modalInteraction('flow:watchconfig:submit', { keywords: 'mint, drop , launch', sourceUrl: 'https://example.com/feed' }, 'user-2');
  await handler(configSubmit);
  const confirm = buttonInteraction('flow:watchconfirm', 'user-2');
  await handler(confirm);
  assert.deepEqual(created[0].input.config, { keywords: ['mint', 'drop', 'launch'], sourceUrl: 'https://example.com/feed' });
});

test('an empty required field in the config modal is rejected without advancing the flow', async () => {
  const { handler, created } = fixture();
  await handler(buttonInteraction('watch:add:start', 'user-3'));
  await handler(modalInteraction('flow:watchname:submit', { value: 'Channel watch' }, 'user-3'));
  await handler(selectInteraction('flow:watchtype:select', ['discord_channel'], 'user-3'));
  await handler(selectInteraction('flow:watchmethod:select', ['official_api'], 'user-3'));
  const badSubmit = modalInteraction('flow:watchconfig:submit', { channelId: '   ' }, 'user-3');
  await handler(badSubmit);
  assert.match(badSubmit.replies[0].content, /cannot be empty/);
  assert.equal(created.length, 0);

  const retry = modalInteraction('flow:watchconfig:submit', { channelId: '123456789' }, 'user-3');
  await handler(retry);
  assert.match(retry.replies[0].content, /Confirm watch rule/);
});

test('an invalid watch rule name is rejected without advancing the flow', async () => {
  const { handler } = fixture();
  await handler(buttonInteraction('watch:add:start', 'user-4'));
  const badName = modalInteraction('flow:watchname:submit', { value: '' }, 'user-4');
  await handler(badName);
  assert.match(badName.replies[0].content, /1-100 characters/);

  // Matches the pre-existing flow:label:submit behavior for wallet create/import: the flow is
  // left active at the same step rather than cleared, so in practice the user has to cancel and
  // restart to get a fresh modal (Discord modals can't be resubmitted once closed). This confirms
  // the flow state itself isn't corrupted by the rejected submission -- a second, valid submission
  // against the same still-active step is accepted correctly.
  const secondSubmission = modalInteraction('flow:watchname:submit', { value: 'Valid name' }, 'user-4');
  await handler(secondSubmission);
  assert.match(secondSubmission.replies[0].content, /What do you want to watch/);
});

test('the rule list lets you manage, disable/re-enable, and remove a rule with confirmation', async () => {
  const { handler, rules } = fixture({ rules: [{ id: 'rule-9', name: 'Existing rule', type: 'discord_channel', method: 'official_api', config: { channelId: '1' }, enabled: true }] });

  const list = buttonInteraction('watch:list', 'user-5');
  await handler(list);
  assert.match(list.updates[0].content, /Your social watch rules/);
  const option = list.updates[0].components[0].components[0].options[0];
  assert.equal(option.value, 'rule-9');

  const manage = selectInteraction('watch:manage:select', ['rule-9'], 'user-5');
  await handler(manage);
  assert.match(manage.updates[0].content, /Existing rule/);
  assert.match(manage.updates[0].content, /enabled/);

  const disable = buttonInteraction('watch:toggle:rule-9', 'user-5');
  await handler(disable);
  assert.match(disable.updates[0].content, /disabled/);
  assert.equal(rules[0].enabled, false);

  const reenable = buttonInteraction('watch:toggle:rule-9', 'user-5');
  await handler(reenable);
  assert.match(reenable.updates[0].content, /🟢 enabled/);
  assert.equal(rules[0].enabled, true);

  const removeAsk = buttonInteraction('watch:remove:ask:rule-9', 'user-5');
  await handler(removeAsk);
  assert.match(removeAsk.updates[0].content, /Remove watch rule Existing rule\?/);
  assert.equal(rules.length, 1, 'nothing removed yet -- confirmation only');

  const removeDo = buttonInteraction('watch:remove:do:rule-9', 'user-5');
  await handler(removeDo);
  assert.equal(rules.length, 0);
  assert.match(removeDo.updates[0].content, /No social watch rules yet/);
});

test('navigating away mid-flow silently abandons it and switches immediately, no confirmation', async () => {
  const { handler } = fixture();
  await handler(buttonInteraction('watch:add:start', 'user-6'));
  await handler(modalInteraction('flow:watchname:submit', { value: 'Diverge test' }, 'user-6'));
  // menu:wallets, not menu:mint/menu:tasks, since Section O now makes both of those perform a
  // real action requiring their own command mocks -- this probe just needs any other menu tap
  // that still renders a static, no-data-fetch screen
  const divert = buttonInteraction('menu:wallets', 'user-6');
  await handler(divert);
  assert.match(divert.updates[0].content, /Wallets/);

  // the abandoned flow must actually be gone -- a follow-up tap that only makes sense mid-watch-
  // rule-creation (the type select the name step would normally lead to) must be silently ignored.
  const stray = selectInteraction('flow:watchtype:select', ['twitter_account'], 'user-6');
  await handler(stray);
  assert.equal(stray.updates.length, 0);
  assert.equal(stray.replies.length, 0);
});

test('a validation error from createWatchRule is shown, and the flow is cleared so the user can start over', async () => {
  const { handler } = fixture({ commands: { createWatchRule: async () => { throw new ValidationError({ field: 'config.handle', message: 'must be provided' }); } } });
  await handler(buttonInteraction('watch:add:start', 'user-7'));
  await handler(modalInteraction('flow:watchname:submit', { value: 'Bad rule' }, 'user-7'));
  await handler(selectInteraction('flow:watchtype:select', ['twitter_account'], 'user-7'));
  await handler(selectInteraction('flow:watchmethod:select', ['official_api'], 'user-7'));
  await handler(modalInteraction('flow:watchconfig:submit', { handle: 'x' }, 'user-7'));
  const confirm = buttonInteraction('flow:watchconfirm', 'user-7');
  await handler(confirm);
  assert.match(confirm.updates[0].content, /must be provided/);

  const retry = buttonInteraction('watch:add:start', 'user-7');
  await handler(retry);
  assert.equal(retry.modal.custom_id, 'flow:watchname:submit');
});
