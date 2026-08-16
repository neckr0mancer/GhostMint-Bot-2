const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mainMenu, walletsMenu, settingsMenu, tasksMenu, chainPicker, walletPicker,
  contractDetails, taskConfirmation, confirmCancelPrompt, confirmRemoveWallet, placeholderMenu,
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

test('the tasks menu offers a way to schedule a mint and a way back to the main menu', () => {
  const buttons = flatButtons(tasksMenu().replyMarkup).map(b => b.callback_data);
  assert.deepEqual(buttons, ['menu:schedule', 'menu:main']);
});

test('contract details renders every known field and degrades gracefully with none of the optional ones', () => {
  const full = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 10000, maxPerWallet: 3, startTime: Math.floor(Date.now() / 1000) + 3_600,
    collection: { name: 'Cool Cats', description: 'A collection', floorPrice: 0.5, floorPriceSymbol: 'ETH' },
    soldOut: false, displayPrice: { eth: 0.05, usd: 150.25, source: 'mint' },
  });
  assert.match(full.text, /Cool Cats/);
  assert.match(full.text, /SeaDrop drop/);
  assert.match(full.text, /Price: 0\.05 per item \(~\$150\.25\)/);
  assert.match(full.text, /Max per wallet: 3/);
  assert.match(full.text, /Max supply: 10000/);
  assert.match(full.text, /Opens:/);
  assert.match(full.text, /A collection/);
  const buttons = flatButtons(full.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data), ['flow:mintdetailscontinue', 'flow:cancel:ask']);

  const minimal = contractDetails({
    contractAddress: '0xdef', chainLabel: 'Base', isSeaDrop: false, priceUnknown: true,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null, soldOut: false, displayPrice: null,
  });
  assert.match(minimal.text, /Contract details/);
  assert.match(minimal.text, /Standard mint\(uint256\)/);
  assert.match(minimal.text, /not exposed by this contract/);
  assert.equal(minimal.text.includes('Max per wallet'), false);
  assert.equal(minimal.text.includes('Opens'), false);
});

test('an already-open SeaDrop opening time renders as "Opened", not "Opens"', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: Math.floor(Date.now() / 1000) - 3_600, collection: null,
    soldOut: false, displayPrice: null,
  });
  assert.match(details.text, /Opened:/);
  assert.equal(details.text.includes('Opens:'), false);
});

test('a sold-out collection shows the OpenSea floor price instead of the mint price, with a USD equivalent', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: true, displayPrice: { eth: 0.3, usd: 900, source: 'floor' },
  });
  assert.match(details.text, /Status: Sold out — floor price 0\.3 ETH \(~\$900\.00\)/);
  assert.equal(details.text.includes('Price: 0.05 per item'), false);
});

test('a sold-out collection with a genuine floor price of 0 shows 0, not "unavailable"', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: true, displayPrice: { eth: 0, usd: 0, source: 'floor' },
  });
  assert.match(details.text, /Status: Sold out — floor price 0 ETH \(~\$0\.00\)/);
  assert.equal(details.text.includes('unavailable'), false);
});

test('a sold-out collection with no OpenSea floor data at all says so plainly', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: true, displayPrice: null,
  });
  assert.match(details.text, /Status: Sold out — floor price unavailable/);
});

test('a missing USD price omits the parenthetical entirely rather than showing $NaN', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: false, displayPrice: { eth: 0.05, usd: null, source: 'mint' },
  });
  assert.match(details.text, /Price: 0\.05 per item$/m);
  assert.equal(details.text.includes('~$'), false);
});

test('task confirmation names the auto-detected opening time distinctly from a manually entered one', () => {
  const startTime = Math.floor(Date.now() / 1000) + 3_600;
  const mintTime = new Date(startTime * 1000).toISOString();
  const auto = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime, autoDetectedTime: true, priceETH: 0.1, priceUnknown: false,
  });
  assert.match(auto.text, /this contract's own opening time/);
  const manual = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime, autoDetectedTime: false, priceETH: 0.1, priceUnknown: false,
  });
  assert.equal(manual.text.includes("this contract's own opening time"), false);
  assert.deepEqual(flatButtons(auto.replyMarkup).map(b => b.callback_data), ['flow:taskconfirm', 'flow:cancel:ask']);
});

test('task confirmation appends a USD equivalent to the price when a displayPrice is known', () => {
  const withUsd = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', autoDetectedTime: false, priceETH: 0.1, priceUnknown: false,
    displayPrice: { eth: 0.1, usd: 300, source: 'mint' },
  });
  assert.match(withUsd.text, /Price: 0\.1 per item \(read from the contract\) \(~\$300\.00\)/);
  const withoutUsd = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', autoDetectedTime: false, priceETH: 0.1, priceUnknown: false,
  });
  assert.equal(withoutUsd.text.includes('~$'), false);
});
