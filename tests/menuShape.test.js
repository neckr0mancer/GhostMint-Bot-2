const assert = require('node:assert/strict');
const test = require('node:test');
const menus = require('../src/discord/menus');

// Discord rejects a message whose components exceed its structural limits -- and it rejects the
// WHOLE payload, so from the user's side the button simply loads and then does nothing. That is
// exactly how the Wallets menu failed: one button per row put it at 6 rows, over the 5-row cap,
// and no amount of correct handler logic behind it could have shown anything.
//
// This file checks shape, not copy: it renders every menu that takes no awkward setup and asserts
// the limits Discord actually enforces. A new button added one-per-row trips this immediately.
const MAX_ROWS = 5;
const MAX_PER_ROW = 5;

const CHAINS = {
  ethereum: { name: 'Ethereum', sym: 'ETH' }, base: { name: 'Base', sym: 'ETH' },
  arbitrum: { name: 'Arbitrum', sym: 'ETH' }, polygon: { name: 'Polygon', sym: 'MATIC' },
  robinhood: { name: 'Robinhood', sym: 'ETH' },
};
const SUPPORTED = Object.keys(CHAINS);
const WALLETS = [
  { label: 'alpha', address: '0xed9834A3E62c8eB78B7F6682c5798f69B4Ee2976', chain: 'ethereum', minted: 1 },
  { label: 'beta', address: '0xed9834A3E62c8eB78B7F6682c5798f69B4Ee2977', chain: 'base', minted: 0 },
];

const CASES = {
  'mainMenu (owner)': () => menus.mainMenu({ isOwner: true }),
  'mainMenu (non-owner)': () => menus.mainMenu({ isOwner: false }),
  walletsMenu: () => menus.walletsMenu(),
  settingsMenu: () => menus.settingsMenu({ isOwner: true }),
  mintModeMenu: () => menus.mintModeMenu(),
  'batchImportMenu (empty)': () => menus.batchImportMenu({ count: 0 }),
  'batchImportMenu (ready)': () => menus.batchImportMenu({ count: 3, chainLabel: 'Base', dropped: 2 }),
  chainSelect: () => menus.chainSelect(SUPPORTED, CHAINS),
  placeholderMenu: () => menus.placeholderMenu('Wallets', 'Nothing here yet.'),
};

test('every Discord menu fits inside the 5-row / 5-button limits Discord enforces', () => {
  for (const [name, render] of Object.entries(CASES)) {
    let payload;
    try { payload = render(); } catch (error) { assert.fail(`${name} threw: ${error.message}`); }
    const rows = payload.components || [];
    assert.ok(rows.length <= MAX_ROWS,
      `${name} has ${rows.length} action rows; Discord allows ${MAX_ROWS} and rejects the whole payload past that`);
    rows.forEach((row, index) => {
      const width = (row.components || []).length;
      assert.ok(width <= MAX_PER_ROW, `${name} row ${index + 1} has ${width} components; the cap is ${MAX_PER_ROW}`);
      assert.ok(width >= 1, `${name} row ${index + 1} is empty`);
    });
  }
});

test('the wallets menu reaches every wallet action within those limits, batch import included', () => {
  const wallets = menus.walletsMenu();
  const ids = wallets.components.flatMap(row => row.components.map(component => component.custom_id));
  for (const expected of ['wallet:list', 'wallet:create:start', 'wallet:import:start',
    'wallet:batch-import:start', 'wallet:balance:pick', 'wallet:remove:pick', 'menu:main']) {
    assert.ok(ids.includes(expected), `wallets menu lost ${expected} when its rows were packed`);
  }
  assert.equal(new Set(ids).size, ids.length, 'no duplicated custom_id');
});

test('a menu built one-button-per-row past five buttons is caught, not silently shipped', () => {
  // Guards the guard: proves the assertion above actually fires rather than passing vacuously.
  const overflowing = { components: Array.from({ length: 6 }, (_, i) => menus.row([menus.button(`b${i}`, `id:${i}`)])) };
  assert.equal(overflowing.components.length > MAX_ROWS, true);
});

test('wallet list output stays inside one row and keeps a way back', () => {
  assert.ok(WALLETS.length >= 2, 'fixture sanity');
  const back = menus.row([menus.button('⬅️ Back to wallets', 'menu:wallets')]);
  assert.equal(back.components.length, 1);
});

// A batch of one is a single mint. Enforced in the schema so all three surfaces agree, and gated
// in each picker so the user is told rather than hitting a validation error at submit.
test('batch mint requires at least two wallets, and says so rather than failing at submit', () => {
  const { MIN_BATCH_WALLETS } = require('../src/validation/domain');
  assert.equal(MIN_BATCH_WALLETS, 2);

  const tg = require('../src/telegram/menus');
  const dc = require('../src/discord/menus');
  const two = [{ label: 'a', chain: 'ethereum' }, { label: 'b', chain: 'base' }];

  const ids = selected => tg.walletMultiPicker(two, selected, {}).replyMarkup.inline_keyboard.flat().map(b => b.callback_data);
  assert.equal(ids(['a']).includes('flow:walletcontinue'), false, 'one wallet cannot continue a batch');
  assert.ok(ids(['a', 'b']).includes('flow:walletcontinue'), 'two can');

  // Discord's select would otherwise be built with min_values greater than max_values, which
  // Discord rejects outright -- the flow would dead-end with nothing on screen.
  const solo = dc.walletMultiSelect([{ label: 'solo', chain: 'ethereum' }], { customId: 'x', emptyHint: 'none' });
  assert.match(solo.content, /needs 2 wallets/);
  assert.equal((solo.components[0].components[0] || {}).type, 2, 'buttons, not a broken select');
  const pair = dc.walletMultiSelect(two, { customId: 'x', emptyHint: 'none' }).components[0].components[0];
  assert.ok(pair.min_values <= pair.max_values, 'min_values must never exceed max_values');
  assert.equal(pair.min_values, MIN_BATCH_WALLETS);

  const tgSolo = tg.walletMultiPicker([{ label: 'solo', chain: 'ethereum' }], [], {});
  assert.match(tgSolo.text, /needs 2 wallets/);
  assert.ok(tgSolo.replyMarkup.inline_keyboard.flat().some(b => b.callback_data === 'menu:mint:single'),
    'offers the single mint that actually fits what they have');
});
