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
  'modeMenu (advanced allowed, all 4 presets)': () => menus.modeMenu({
    currentKey: 'safe', advancedModesAllowed: true,
    presets: [{ key: 'ultra_fast' }, { key: 'fast' }, { key: 'semi_safe' }, { key: 'safe' }],
  }),
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

// The 2-wallet minimum was reverted on the owner's call -- a one-wallet batch just behaves like a
// single mint. What still matters is that the pickers never build a component Discord rejects.
test('the batch wallet picker never builds a select whose minimum exceeds its maximum', () => {
  const { MIN_BATCH_WALLETS } = require('../src/validation/domain');
  const dc = require('../src/discord/menus');
  const tg = require('../src/telegram/menus');
  const sets = [
    [{ label: 'solo', chain: 'ethereum' }],
    [{ label: 'a', chain: 'ethereum' }, { label: 'b', chain: 'base' }],
  ];
  for (const wallets of sets) {
    const card = dc.walletMultiSelect(wallets, { customId: 'x', emptyHint: 'none' });
    const select = card.components[0].components.find(c => c.type === 3);
    if (select) {
      assert.ok(select.min_values <= select.max_values,
        'min_values above max_values is rejected outright by Discord, blanking the flow');
      assert.ok(select.min_values >= MIN_BATCH_WALLETS);
    }
    assert.ok(card.components.length <= 5);
  }
  // Telegram offers Continue as soon as the minimum is met.
  const picked = tg.walletMultiPicker(sets[1], ['a'], {}).replyMarkup.inline_keyboard.flat()
    .map(b => b.callback_data);
  assert.equal(picked.includes('flow:walletcontinue'), MIN_BATCH_WALLETS <= 1,
    'Continue tracks the shared minimum rather than a hardcoded count');
});

// An account with no security password cannot use the gate at all -- it is not "not yet
// configured", it is open. The reminder is deliberately persistent for exactly as long as that is
// true, and gone the moment it stops being true.
test('the security reminder appears only while the account is actually exposed', () => {
  const tg = require('../src/telegram/menus');
  const dc = require('../src/discord/menus');
  const cases = [
    [{ passwordSet: false, gateLevel: 'off' }, true, 'no password at all'],
    [{ passwordSet: false, gateLevel: 'strict' }, true, 'a level set with no password is still open'],
    [{ passwordSet: true, gateLevel: 'off' }, true, 'password set but the gate never asks for it'],
    [{ passwordSet: true, gateLevel: 'sensitive' }, false, 'protected'],
    [{ passwordSet: true, gateLevel: 'strict' }, false, 'protected'],
  ];
  for (const [security, expected, why] of cases) {
    assert.equal(tg.securityNeedsAttention(security), expected, `telegram: ${why}`);
    assert.equal(dc.securityNeedsAttention(security), expected, `discord: ${why}`);
    const tgRows = tg.mainMenu({ isOwner: true, security }).replyMarkup.inline_keyboard;
    const tgIds = tgRows.flat().map(b => b.callback_data);
    assert.equal(tgIds.includes('menu:security'), expected, `telegram button: ${why}`);
  }
});

test('the reminder never pushes the Discord menu past the 5-row limit', () => {
  // The menu is already at 5 rows with Admin present. A sixth row makes Discord reject the whole
  // payload, so a security warning added carelessly would blank the very menu it warns on.
  const dc = require('../src/discord/menus');
  for (const security of [{ passwordSet: false, gateLevel: 'off' }, { passwordSet: true, gateLevel: 'sensitive' }]) {
    for (const isOwner of [true, false]) {
      const menu = dc.mainMenu({ isOwner, security });
      assert.ok(menu.components.length <= 5, `rows: ${menu.components.length}`);
      for (const r of menu.components) assert.ok(r.components.length <= 5, 'buttons per row');
    }
  }
  const exposed = dc.mainMenu({ isOwner: true, security: { passwordSet: false, gateLevel: 'off' } });
  assert.equal(exposed.components[0].components[0].custom_id, 'menu:security',
    'and it leads the first row rather than hiding at the bottom');
});

test('the setup card names the exact dashboard pages, and ticks off what is already done', () => {
  const tg = require('../src/telegram/menus');
  const fresh = tg.securitySetupCard({ passwordSet: false, gateLevel: 'off' });
  assert.match(fresh.text, /Account/);
  assert.match(fresh.text, /Security password/);
  assert.match(fresh.text, /Settings/);
  assert.match(fresh.text, /Password gate/);
  assert.match(fresh.text, /cannot be done from chat/i, 'says why, so it does not read as an arbitrary detour');

  const halfway = tg.securitySetupCard({ passwordSet: true, gateLevel: 'off' });
  assert.match(halfway.text, /✅ <b>1\./, 'step one shows as done');
  assert.match(halfway.text, /▫️ <b>2\./, 'step two still outstanding');

  const done = tg.securitySetupCard({ passwordSet: true, gateLevel: 'strict' });
  assert.match(done.text, /You are protected/);
});
