const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mainMenu, walletsMenu, settingsMenu, chainPicker, walletPicker,
  confirmCancelPrompt, confirmRemoveWallet, placeholderMenu,
} = require('../src/telegram/menus');

function flatButtons(replyMarkup) {
  return replyMarkup.inline_keyboard.flat();
}

test('the main menu hides the admin section from non-owners and shows it for owners', () => {
  const forUser = mainMenu({ isOwner: false });
  const forOwner = mainMenu({ isOwner: true });
  assert.equal(flatButtons(forUser.replyMarkup).some(b => b.callback_data === 'menu:admin'), false);
  assert.equal(flatButtons(forOwner.replyMarkup).some(b => b.callback_data === 'menu:admin'), true);
});

test('every main menu button has a unique, non-empty callback_data', () => {
  const buttons = flatButtons(mainMenu({ isOwner: true }).replyMarkup);
  const dataValues = buttons.map(b => b.callback_data);
  assert.ok(dataValues.every(value => typeof value === 'string' && value.length > 0));
  assert.equal(new Set(dataValues).size, dataValues.length);
});

test('the wallets menu offers every wallet action and a way back to the main menu', () => {
  const buttons = flatButtons(walletsMenu().replyMarkup).map(b => b.callback_data);
  for (const expected of ['wallet:list', 'wallet:create:start', 'wallet:import:start', 'wallet:balance:pick', 'wallet:remove:pick', 'menu:main']) {
    assert.ok(buttons.includes(expected), `missing ${expected}`);
  }
});

test('settings shows the link button to every user and admin console only to owners', () => {
  const buttons = flatButtons(settingsMenu({ isOwner: false }).replyMarkup).map(b => b.callback_data);
  assert.ok(buttons.includes('link:generate'));
  assert.equal(buttons.includes('menu:admin'), false);
  assert.ok(flatButtons(settingsMenu({ isOwner: true }).replyMarkup).some(b => b.callback_data === 'menu:admin'));
});

test('chain picker renders one button per supported chain plus a cancel option', () => {
  const chains = { ethereum: { name: 'Ethereum' }, sepolia: { name: 'Sepolia' } };
  const picker = chainPicker(['ethereum', 'sepolia'], chains);
  const buttons = flatButtons(picker.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data), ['flow:chain:ethereum', 'flow:chain:sepolia', 'flow:cancel:ask']);
  assert.equal(buttons[0].text, 'Ethereum');
});

test('wallet picker shows an empty-state menu instead of an empty keyboard', () => {
  const empty = walletPicker([], { prefix: 'wallet:balance', emptyHint: 'No wallets yet.' });
  assert.match(empty.text, /No wallets yet/);
  assert.equal(flatButtons(empty.replyMarkup).length, 1);
});

test('wallet picker lists each wallet with a prefixed callback and its chain in the label', () => {
  const picker = walletPicker([{ label: 'main', chain: 'ethereum' }, { label: 'spare', chain: 'base' }], { prefix: 'wallet:balance' });
  const buttons = flatButtons(picker.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data), ['wallet:balance:main', 'wallet:balance:spare', 'menu:wallets']);
  assert.match(buttons[0].text, /main.*ethereum/);
});

test('the cancel-confirmation prompt names the in-progress flow and offers both outcomes', () => {
  const prompt = confirmCancelPrompt('wallet creation');
  assert.match(prompt.text, /wallet creation/);
  const buttons = flatButtons(prompt.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data), ['flow:cancel:confirm', 'flow:cancel:resume']);
});

test('the remove-wallet confirmation embeds the exact label being removed', () => {
  const prompt = confirmRemoveWallet('cold-storage');
  assert.match(prompt.text, /cold-storage/);
  const buttons = flatButtons(prompt.replyMarkup);
  assert.equal(buttons[0].callback_data, 'wallet:remove:do:cold-storage');
});

test('placeholder menu always offers a way back to the main menu', () => {
  const menu = placeholderMenu('Mint', 'Use /mintnow for now.');
  assert.deepEqual(flatButtons(menu.replyMarkup).map(b => b.callback_data), ['menu:main']);
});
