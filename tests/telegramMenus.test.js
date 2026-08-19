const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mainMenu, walletsMenu, settingsMenu, tasksMenu, taskActions, confirmCancelTask, chainPicker, walletPicker,
  contractDetails, contractDetailsText, collectionInfoCard, mintConfirmation, gasTolerancePrompt,
  taskConfirmation, taskScheduled, confirmRemoveWallet, placeholderMenu,
  sniperMenu, activityMenu, adminOverviewMenu,
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
  assert.equal(buttons[0].text, '💎 Ethereum');
  assert.equal(buttons[1].text, 'Sepolia', 'a chain with no Unicode pick in CHAIN_EMOJI falls back to a bare label');
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

// Live-reported: this used to always show the empty-state placeholder text ("Use /tasks to list,
// /canceltask, /pausetask..."), never an actual list, regardless of how many tasks existed.
test('a populated tasks page lists every task with a Cancel button beside it when cancel is valid for that status', () => {
  const page = { page: 1, totalPages: 1, total: 3, items: [
    { id: 'a', name: 'Drop A', status: 'scheduled', contract: '0xa', walletLabel: 'main', qty: 1, price: 0.1, mintTime: Date.now() + 60000 },
    { id: 'b', name: 'Drop B', status: 'paused', contract: '0xb', walletLabel: 'main', qty: 1, price: 0, mintTime: Date.now() + 60000 },
    { id: 'c', name: 'Drop C', status: 'claimed', contract: '0xc', walletLabel: 'main', qty: 1, price: 0.2, mintTime: Date.now() + 60000 },
  ] };
  const menu = tasksMenu(page);
  const rows = menu.replyMarkup.inline_keyboard;
  assert.deepEqual(rows[0].map(b => b.callback_data), ['task:manage:a', 'task:cancel:ask:a']);
  assert.deepEqual(rows[1].map(b => b.callback_data), ['task:manage:b', 'task:cancel:ask:b']);
  // 'claimed' is not a cancellable status (schedulerRepository.cancel only accepts
  // scheduled/retry/paused) -- no dead Cancel button that would just fail if tapped.
  assert.deepEqual(rows[2].map(b => b.callback_data), ['task:manage:c']);
  assert.match(menu.text, /Tasks \(page 1\/1, 3 total\)/);
});

test('the tasks page shows Prev/Next paging the same way the activity menu does', () => {
  const page = { page: 2, totalPages: 3, total: 25, items: [
    { id: 'a', name: 'Drop A', status: 'scheduled', contract: '0xa', walletLabel: 'main', qty: 1, price: 0.1, mintTime: Date.now() + 60000 },
  ] };
  const buttons = flatButtons(tasksMenu(page).replyMarkup).map(b => b.callback_data);
  assert.ok(buttons.includes('task:page:1'));
  assert.ok(buttons.includes('task:page:3'));
});

test('taskActions shows only the action(s) valid for the task\'s current status', () => {
  const base = { id: 'a', name: 'Drop A', contract: '0xa', walletLabel: 'main', qty: 1, price: 0.1, mintTime: Date.now() + 60000 };
  assert.deepEqual(flatButtons(taskActions({ ...base, status: 'scheduled' }).replyMarkup).map(b => b.callback_data),
    ['task:pause:a', 'task:cancel:ask:a', 'menu:tasks']);
  assert.deepEqual(flatButtons(taskActions({ ...base, status: 'paused' }).replyMarkup).map(b => b.callback_data),
    ['task:resume:a', 'task:cancel:ask:a', 'menu:tasks']);
  assert.deepEqual(flatButtons(taskActions({ ...base, status: 'failed' }).replyMarkup).map(b => b.callback_data),
    ['task:retry:a', 'menu:tasks']);
  assert.deepEqual(flatButtons(taskActions({ ...base, status: 'claimed' }).replyMarkup).map(b => b.callback_data),
    ['menu:tasks']);
});

test('confirmCancelTask asks before cancelling and names the exact task', () => {
  const menu = confirmCancelTask({ id: 'a', name: 'Drop A' });
  assert.match(menu.text, /Cancel <b>Drop A<\/b>/);
  assert.deepEqual(flatButtons(menu.replyMarkup).map(b => b.callback_data), ['task:cancel:do:a', 'task:manage:a']);
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
  assert.match(minimal.text, /The Deets/);
  assert.match(minimal.text, /Standard mint\(uint256\)/);
  assert.match(minimal.text, /not determinable/);
  assert.equal(minimal.text.includes('Max per wallet'), false);
  assert.equal(minimal.text.includes('Opens'), false);
});

test('contractDetailsText is exactly contractDetails\' text, without the Continue/Cancel keyboard (Section M reuses it as a header on other screens)', () => {
  const fields = {
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 10000, maxPerWallet: 3, startTime: Math.floor(Date.now() / 1000) + 3_600,
    collection: { name: 'Cool Cats', description: 'A collection' }, soldOut: false, displayPrice: null,
  };
  assert.equal(contractDetailsText(fields), contractDetails(fields).text);
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
  assert.match(details.text, /Status: Sold out\. Floor's sitting at 0\.3 ETH \(~\$900\.00\)/);
  assert.equal(details.text.includes('Price: 0.05 per item'), false);
});

test('a sold-out collection with a genuine floor price of 0 shows 0, not "unavailable"', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: true, displayPrice: { eth: 0, usd: 0, source: 'floor' },
  });
  assert.match(details.text, /Status: Sold out\. Floor's sitting at 0 ETH \(~\$0\.00\)/);
  assert.equal(details.text.includes('unavailable'), false);
});

test('a sold-out collection with no OpenSea floor data at all says the floor could not be determined, not "ghosted us"', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: null, maxPerWallet: null, startTime: null, collection: null,
    soldOut: true, displayPrice: null,
  });
  assert.match(details.text, /Status: Sold out\. Floor price couldn't be determined from this contract\./);
});

test('a sold-out collection omits Max per wallet -- there is nothing left to mint, only Max supply (a permanent fact) still shows', () => {
  const details = contractDetails({
    contractAddress: '0xabc', chainLabel: 'Ethereum', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 5000, maxPerWallet: 3, startTime: null, collection: null,
    soldOut: true, displayPrice: null,
  });
  assert.equal(details.text.includes('Max per wallet'), false);
  assert.match(details.text, /Max supply: 5000/);
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

test('collectionInfoCard renders the mint_guided flow\'s real first screen: Mint Now, Refresh, Copy CA, Cancel, with OpenSea only when a link is given', () => {
  const withoutOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.deepEqual(flatButtons(withoutOpenSea.replyMarkup).map(b => b.callback_data), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'flow:copyca', 'flow:cancel:ask']);

  const withOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null,
    openSeaUrl: 'https://opensea.io/assets/ethereum/0xabc',
  });
  const buttons = flatButtons(withOpenSea.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data || b.url), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'https://opensea.io/assets/ethereum/0xabc', 'flow:copyca', 'flow:cancel:ask']);
  assert.equal(buttons.find(b => b.url)?.text, '🔗 OpenSea');
});

test('collectionInfoCard suggests scheduling only when the detected opening time is still in the future', () => {
  const future = Math.floor(Date.now() / 1000) + 3_600;
  const past = Math.floor(Date.now() / 1000) - 3_600;

  const notYetOpen = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: future, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.deepEqual(flatButtons(notYetOpen.replyMarkup).map(b => b.callback_data),
    ['flow:mintdetailscontinue', 'flow:schedulesuggest:0xabc', 'flow:detailsrefresh', 'flow:copyca', 'flow:cancel:ask']);
  assert.match(notYetOpen.text, /Opens:/);

  const alreadyOpen = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: past, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.equal(flatButtons(alreadyOpen.replyMarkup).some(b => b.callback_data?.startsWith('flow:schedulesuggest:')), false);
  assert.match(alreadyOpen.text, /Opened:/);
});

test('collectionInfoCard omits the stats table entirely when stats is null, and renders an aligned floor/holders/minted/volume table -- never a market cap -- when it is not', () => {
  const noStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.equal(noStats.text.includes('📈'), false);
  assert.equal(noStats.text.includes('<pre>'), false);
  assert.equal(noStats.text.includes('Floor'), false);

  const withStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, openSeaUrl: null,
    stats: {
      floorPrice: 0.08, floorPriceSymbol: 'ETH', numOwners: 42, totalMinted: 55,
      marketCap: 4.4, volume: { oneDay: 1.2, sevenDay: 5.5, thirtyDay: null, allTime: 20 },
    },
  });
  assert.match(withStats.text, /<pre>[\s\S]*Floor\s+0\.08 ETH[\s\S]*<\/pre>/);
  assert.match(withStats.text, /Holders\s+42/);
  assert.match(withStats.text, /Minted\s+55\/100/);
  assert.match(withStats.text, /24h volume\s+1\.2 ETH/);
  assert.match(withStats.text, /7d volume\s+5\.5 ETH/);
  assert.equal(withStats.text.includes('30d'), false);
  assert.equal(withStats.text.includes('Market cap'), false);
});

test('mintConfirmation omits the gas tolerance line for a plain /mint, and shows it for a /batch that went through the gas-tolerance step', () => {
  const plainMint = mintConfirmation({
    contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabels: ['main'], quantity: 1, priceETH: 0.05, priceUnknown: false,
  });
  assert.equal(plainMint.text.includes('Gas tolerance'), false);

  const batchNoLimit = mintConfirmation({
    contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabels: ['a', 'b'], quantity: 1, priceETH: 0.05, priceUnknown: false, maxGasGwei: null,
  });
  assert.match(batchNoLimit.text, /Gas tolerance: no extra limit \(account ceiling only\)/);

  const batchWithLimit = mintConfirmation({
    contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabels: ['a', 'b'], quantity: 1, priceETH: 0.05, priceUnknown: false, maxGasGwei: 25,
  });
  assert.match(batchWithLimit.text, /Gas tolerance: up to 25 gwei/);
});

test('gasTolerancePrompt shows the live gas price for context and offers a no-limit accept alongside a manual entry', () => {
  const prompt = gasTolerancePrompt({ currentGasGwei: 8, ceilingGwei: 100 });
  assert.match(prompt.text, /Current network gas price: <b>8 gwei<\/b>/);
  assert.match(prompt.text, /Your account's gas ceiling: <b>100 gwei<\/b>/);
  const buttons = flatButtons(prompt.replyMarkup);
  assert.deepEqual(buttons.map(b => b.callback_data), ['flow:gastoleranceaccept', 'flow:gastolerancemanual', 'flow:cancel:ask']);
  assert.match(buttons[0].text, /up to 100 gwei/);
});

test('gasTolerancePrompt says plainly when the live gas price could not be fetched, instead of showing a broken number', () => {
  const prompt = gasTolerancePrompt({ currentGasGwei: null, ceilingGwei: 50 });
  assert.match(prompt.text, /Current network gas price is MIA right now/);
  assert.equal(prompt.text.includes('null'), false);
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
  assert.match(withUsd.text, /Price: 0\.1 per item \(straight from the contract\) \(~\$300\.00\)/);
  const withoutUsd = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', autoDetectedTime: false, priceETH: 0.1, priceUnknown: false,
  });
  assert.equal(withoutUsd.text.includes('~$'), false);
});

// The old copy ended on "Set the alarm?", which reads like a reminder -- the bot actually signs and
// broadcasts the mint unattended, which is a materially different thing to be agreeing to.
test('task confirmation says the bot executes the mint itself rather than reminding the user', () => {
  const prompt = taskConfirmation({
    name: 'drop', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', autoDetectedTime: false, priceETH: 0.1, priceUnknown: false,
  });
  assert.match(prompt.text, /not a reminder/i);
  assert.match(prompt.text, /signs and sends/i);
  assert.equal(/alarm/i.test(prompt.text), false);
});

test('a later phase is labelled as one and never claims its price came from the contract', () => {
  const base = {
    name: 'phase 2 public', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', autoDetectedTime: false, priceETH: 0.08,
  };
  // priceUnknown is set for every phase past the first (it is what forces the manual price step),
  // but the reason is "the chain only describes the live stage", not "this contract hides its price".
  const phase = taskConfirmation({ ...base, priceUnknown: true, phaseNumber: 2 });
  assert.match(phase.text, /Confirm phase 2/);
  assert.match(phase.text, /Price: 0\.08 per item \(your number for this phase\)/);
  assert.equal(phase.text.includes('not exposed by this contract'), false);
  const first = taskConfirmation({ ...base, priceUnknown: true, phaseNumber: 1 });
  assert.match(first.text, /Confirm scheduled mint/);
  assert.match(first.text, /not exposed by this contract/);
});

test('the scheduled-task screen offers the next phase for the same contract', () => {
  const screen = taskScheduled({
    name: 'phase 1 allowlist', contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
    mintTime: '2026-08-20T18:00:00.000Z',
  });
  const next = flatButtons(screen.replyMarkup).find(b => b.callback_data.startsWith('flow:phase:'));
  assert.equal(next.callback_data, 'flow:phase:2:0x1234567890abcdef1234567890abcdef12345678');
  assert.match(next.text, /phase 2/i);
  // Telegram rejects callback_data over 64 bytes outright, and this one carries a full address.
  // Every character in it is ASCII (prefix, digits, hex address), so length is the byte count.
  assert.ok(next.callback_data.length <= 64);
});

test('the scheduled-task screen counts phases upward and keeps a way back to the menu', () => {
  const third = taskScheduled({
    name: 'phase 3', contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
    mintTime: '2026-08-20T18:00:00.000Z', phaseNumber: 3,
  });
  assert.match(third.text, /Phase 3 armed/);
  const buttons = flatButtons(third.replyMarkup).map(b => b.callback_data);
  assert.ok(buttons.includes('flow:phase:4:0x1234567890abcdef1234567890abcdef12345678'));
  assert.ok(buttons.includes('menu:main'));
});

// Section O -- Telegram counterparts to Discord's menu:snipers/menu:activity/menu:admin parity
// (tests/discordMenuParity.test.js), performing the same lookups /snipers, /activity, and the
// dashboard's admin overview already do instead of replying "use /snipers" etc.

test('sniperMenu shows the same disclaimer and per-sniper detail as /snipers, with an empty state', () => {
  const empty = sniperMenu([]);
  assert.match(empty.text, /No snipers configured/);
  assert.ok(flatButtons(empty.replyMarkup).some(b => b.callback_data === 'menu:main'));

  const list = sniperMenu([{ label: 'Copy Cool Cats', active: true, targetAddress: '0x1234567890abcdef', chain: 'ethereum', walletLabel: 'main', hits: 3, fails: 1 }]);
  assert.match(list.text, /Post-confirmation copy snipers \(1\)/);
  assert.match(list.text, /Not mempool front-running/);
  assert.match(list.text, /Copy Cool Cats/);
  assert.match(list.text, /Hits: 3 · Fails: 1/);
});

test('activityMenu offers Next on page 1 of many but not Prev, and both on a middle page', () => {
  const first = activityMenu({ page: 1, totalPages: 3, total: 25, items: [{ status: 'success', title: 'Minted', walletLabel: 'main', time: Date.now() }] });
  const firstButtons = flatButtons(first.replyMarkup).map(b => b.callback_data);
  assert.ok(!firstButtons.some(id => id.includes('Prev') || id === 'activity:page:0'));
  assert.ok(firstButtons.includes('activity:page:2'));

  const middle = activityMenu({ page: 2, totalPages: 3, total: 25, items: [] });
  const middleButtons = flatButtons(middle.replyMarkup).map(b => b.callback_data);
  assert.ok(middleButtons.includes('activity:page:1'));
  assert.ok(middleButtons.includes('activity:page:3'));
});

test('activityMenu includes a tx link only when txHash is present, and says so plainly when there is no activity', () => {
  const withTx = activityMenu({ page: 1, totalPages: 1, total: 1, items: [{ status: 'success', title: 'Minted', walletLabel: 'main', time: Date.now(), txHash: '0xabc', explorer: 'https://etherscan.io/tx/' }] });
  assert.match(withTx.text, /View tx/);

  const empty = activityMenu({ page: 1, totalPages: 1, total: 0, items: [] });
  assert.match(empty.text, /No activity yet/);
});

test('adminOverviewMenu shows metrics and per-group ceilings, wording "no ceiling" for a null value', () => {
  const overview = adminOverviewMenu({
    metrics: { totalUsers: 10, activeAnyPlatform24h: 4, owners: 2, rootOwners: 1, groups: 2, linkedAccounts: 6 },
    groups: [
      { name: 'Standard', gasCeilingGwei: 50, maxTransactionValueEth: '0.5', dailySpendingBudgetEth: '2.0' },
      { name: 'Unlimited', gasCeilingGwei: null, maxTransactionValueEth: null, dailySpendingBudgetEth: null },
    ],
  });
  assert.match(overview.text, /10 total/);
  assert.match(overview.text, /2 owners \(1 root\)/);
  assert.match(overview.text, /Standard.*gas ≤50 gwei, tx ≤0\.5, daily ≤2\.0/);
  assert.match(overview.text, /Unlimited.*no ceiling.*no ceiling.*no ceiling/);
});

test('adminOverviewMenu says so plainly when no groups are configured yet', () => {
  const overview = adminOverviewMenu({ metrics: { totalUsers: 1, activeAnyPlatform24h: 0, owners: 1, rootOwners: 1, groups: 0, linkedAccounts: 0 }, groups: [] });
  assert.match(overview.text, /No groups configured yet/);
  assert.match(overview.text, /1 owner \(1 root\)/, 'singular "owner" when the count is exactly 1');
});
