const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mainMenu, walletsMenu, settingsMenu, chainSelect, walletSelect,
  confirmCancelPrompt, confirmRemoveWallet, placeholderMenu, labelModal, collectionInfoCard,
} = require('../src/discord/menus');

function flatButtons(components) {
  return components.flatMap(r => r.components.filter(c => c.type === 2));
}

function selectComponent(components) {
  return components[0].components[0];
}

test('the main menu hides the admin section from non-owners and shows it for owners', () => {
  const forUser = mainMenu({ isOwner: false });
  const forOwner = mainMenu({ isOwner: true });
  assert.equal(flatButtons(forUser.components).some(b => b.custom_id === 'menu:admin'), false);
  assert.equal(flatButtons(forOwner.components).some(b => b.custom_id === 'menu:admin'), true);
});

test('every main menu button has a unique, non-empty custom_id', () => {
  const buttons = flatButtons(mainMenu({ isOwner: true }).components);
  const ids = buttons.map(b => b.custom_id);
  assert.ok(ids.every(value => typeof value === 'string' && value.length > 0));
  assert.equal(new Set(ids).size, ids.length);
});

test('the wallets menu offers every wallet action and a way back to the main menu', () => {
  const buttons = flatButtons(walletsMenu().components).map(b => b.custom_id);
  for (const expected of ['wallet:list', 'wallet:create:start', 'wallet:import:start', 'wallet:balance:pick', 'wallet:remove:pick', 'menu:main']) {
    assert.ok(buttons.includes(expected), `missing ${expected}`);
  }
});

test('settings shows the link button to every user and admin console only to owners', () => {
  const buttons = flatButtons(settingsMenu({ isOwner: false }).components).map(b => b.custom_id);
  assert.ok(buttons.includes('link:enter'));
  assert.equal(buttons.includes('menu:admin'), false);
  assert.ok(flatButtons(settingsMenu({ isOwner: true }).components).some(b => b.custom_id === 'menu:admin'));
});

test('chain select renders one option per supported chain plus a cancel button', () => {
  const chains = { ethereum: { name: 'Ethereum' }, sepolia: { name: 'Sepolia' } };
  const picker = chainSelect(['ethereum', 'sepolia'], chains);
  const options = selectComponent(picker.components).options;
  assert.deepEqual(options.map(o => o.value), ['ethereum', 'sepolia']);
  assert.equal(options[0].label, 'Ethereum');
  const buttons = flatButtons(picker.components);
  assert.deepEqual(buttons.map(b => b.custom_id), ['flow:cancel:ask']);
});

test('wallet select shows an empty-state menu instead of an empty select', () => {
  const empty = walletSelect([], { customId: 'wallet:balance:select', emptyHint: 'No wallets yet.' });
  assert.match(empty.content, /No wallets yet/);
  assert.equal(flatButtons(empty.components).length, 1);
});

test('wallet select lists each wallet as an option with its chain in the label', () => {
  const picker = walletSelect([{ label: 'main', chain: 'ethereum' }, { label: 'spare', chain: 'base' }], { customId: 'wallet:balance:select' });
  const options = selectComponent(picker.components).options;
  assert.deepEqual(options.map(o => o.value), ['main', 'spare']);
  assert.match(options[0].label, /main.*ethereum/);
  assert.equal(selectComponent(picker.components).custom_id, 'wallet:balance:select');
});

test('the cancel-confirmation prompt names the in-progress flow and offers both outcomes', () => {
  const prompt = confirmCancelPrompt('wallet creation');
  assert.match(prompt.content, /wallet creation/);
  const buttons = flatButtons(prompt.components);
  assert.deepEqual(buttons.map(b => b.custom_id), ['flow:cancel:confirm', 'flow:cancel:resume']);
});

test('the remove-wallet confirmation embeds the exact label being removed', () => {
  const prompt = confirmRemoveWallet('cold-storage');
  assert.match(prompt.content, /cold-storage/);
  const buttons = flatButtons(prompt.components);
  assert.equal(buttons[0].custom_id, 'wallet:remove:do:cold-storage');
});

test('placeholder menu always offers a way back to the main menu', () => {
  const menu = placeholderMenu('Mint', 'Use /mint for now.');
  assert.deepEqual(flatButtons(menu.components).map(b => b.custom_id), ['menu:main']);
});

test('collectionInfoCard renders the mint_guided flow\'s real first screen: Mint Now, Refresh, Copy CA, Cancel, with OpenSea only when a link is given', () => {
  const withoutOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.deepEqual(flatButtons(withoutOpenSea.components).map(b => b.custom_id || b.url), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'flow:copyca', 'flow:cancel:ask']);

  const withOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null,
    openSeaUrl: 'https://opensea.io/assets/ethereum/0xabc',
  });
  const buttons = flatButtons(withOpenSea.components);
  assert.deepEqual(buttons.map(b => b.custom_id || b.url), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'https://opensea.io/assets/ethereum/0xabc', 'flow:copyca', 'flow:cancel:ask']);
  assert.equal(buttons.find(b => b.url)?.label, '🔗 OpenSea');
});

test('collectionInfoCard omits every stats-derived line when stats is null, and shows floor/market cap/volume when it is not', () => {
  const noStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.equal(noStats.content.includes('Floor:'), false);
  assert.equal(noStats.content.includes('Market cap:'), false);
  assert.equal(noStats.content.includes('Volume:'), false);

  const withStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, openSeaUrl: null,
    stats: {
      floorPrice: 0.08, floorPriceSymbol: 'ETH', numOwners: 42, totalMinted: 55,
      marketCap: 4.4, volume: { oneDay: 1.2, sevenDay: 5.5, thirtyDay: null, allTime: 20 },
    },
  });
  assert.match(withStats.content, /Floor: 0\.08 ETH · 42 holders/);
  assert.match(withStats.content, /Market cap: 4\.4 ETH \(55\/100 minted\)/);
  assert.match(withStats.content, /Volume: 24h 1\.2 ETH · 7d 5\.5 ETH/);
  assert.equal(withStats.content.includes('30d'), false);
});

test('label modal embeds a single required text input under the given title', () => {
  const modal = labelModal({ customId: 'flow:label:submit', title: 'Wallet label' });
  assert.equal(modal.custom_id, 'flow:label:submit');
  assert.equal(modal.title, 'Wallet label');
  const input = modal.components[0].components[0];
  assert.equal(input.type, 4);
  assert.equal(input.custom_id, 'value');
  assert.equal(input.required, true);
});

test('label modal respects a custom max length for longer fields like private keys', () => {
  const modal = labelModal({ customId: 'flow:key:submit', title: 'Private key', maxLength: 256 });
  assert.equal(modal.components[0].components[0].max_length, 256);
});
