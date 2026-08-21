const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mainMenu, walletsMenu, settingsMenu, chainSelect, walletSelect,
  confirmRemoveWallet, placeholderMenu, labelModal, collectionInfoCard,
  taskNameQuickPicks, taskConfirmation, tasksMenu, snipersMenu, adminOverviewMenu,
  modeMenu, MODE_META, sniperDetailsModal, sniperTolerancePrompt, sniperToleranceModal, sniperConfirmation,
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

// Section O -- the "Transaction mode" button used to have no button/menu path at all: /mode worked
// fine as a slash command, but was only reachable by already knowing it and an exact preset name.
test('settings offers a way into transaction mode for every user, owner or not', () => {
  const buttons = flatButtons(settingsMenu({ isOwner: false }).components).map(b => b.custom_id);
  assert.ok(buttons.includes('menu:mode'));
  assert.ok(flatButtons(settingsMenu({ isOwner: true }).components).some(b => b.custom_id === 'menu:mode'));
});

test('modeMenu offers every preset with the current one checked, plus a way back to settings', () => {
  const presets = [{ key: 'ultra_fast' }, { key: 'fast' }, { key: 'semi_safe' }, { key: 'safe' }];
  const menu = modeMenu({ currentKey: 'semi_safe', presets, advancedModesAllowed: true });
  const buttons = flatButtons(menu.components);
  assert.deepEqual(buttons.map(b => b.custom_id),
    ['mode:pick:ultra_fast', 'mode:pick:fast', 'mode:pick:semi_safe', 'mode:pick:safe', 'menu:settings']);
  const current = buttons.find(b => b.custom_id === 'mode:pick:semi_safe');
  assert.match(current.label, /^✅ /);
  assert.doesNotMatch(buttons.find(b => b.custom_id === 'mode:pick:safe').label, /^✅ /);
  assert.match(menu.content, new RegExp(MODE_META.semi_safe.label));
});

test('modeMenu hides Degen and Fast unless advanced modes are allowed for this user', () => {
  const presets = [{ key: 'ultra_fast' }, { key: 'fast' }, { key: 'semi_safe' }, { key: 'safe' }];
  const locked = modeMenu({ currentKey: 'safe', presets, advancedModesAllowed: false });
  const lockedIds = flatButtons(locked.components).map(b => b.custom_id);
  assert.equal(lockedIds.includes('mode:pick:ultra_fast'), false);
  assert.equal(lockedIds.includes('mode:pick:fast'), false);
  assert.match(locked.content, /require group or admin access/);

  const unlocked = modeMenu({ currentKey: 'safe', presets, advancedModesAllowed: true });
  const unlockedIds = flatButtons(unlocked.components).map(b => b.custom_id);
  assert.ok(unlockedIds.includes('mode:pick:ultra_fast'));
  assert.ok(unlockedIds.includes('mode:pick:fast'));
});

test('chain select offers EVM/Solana, not one option per configured chain, since an EVM key works identically on every one', () => {
  const chains = { ethereum: { name: 'Ethereum' }, base: { name: 'Base' } };
  const picker = chainSelect(['ethereum', 'base'], chains);
  const options = selectComponent(picker.components).options;
  assert.deepEqual(options.map(o => o.value), ['ethereum', 'solana-soon']);
  assert.equal(options[0].label, 'EVM');
  assert.match(options[1].label, /Solana/i);
  const buttons = flatButtons(picker.components);
  assert.deepEqual(buttons.map(b => b.custom_id), ['flow:cancel:ask']);
});

test('chain select shows a note (e.g. explaining Solana is not supported yet) above the prompt when given one', () => {
  const picker = chainSelect(['ethereum'], {}, { note: "Solana wallets aren't supported yet -- this bot is EVM-only for now." });
  assert.match(picker.content, /Solana wallets aren't supported yet/);
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

test('collectionInfoCard renders the mint_guided flow\'s real first screen: Mint Now, Refresh, Cancel, with OpenSea only when a link is given', () => {
  const withoutOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.deepEqual(flatButtons(withoutOpenSea.components).map(b => b.custom_id || b.url), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'flow:cancel:ask']);

  const withOpenSea = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null,
    openSeaUrl: 'https://opensea.io/assets/ethereum/0xabc',
  });
  const buttons = flatButtons(withOpenSea.components);
  assert.deepEqual(buttons.map(b => b.custom_id || b.url), ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'https://opensea.io/assets/ethereum/0xabc', 'flow:cancel:ask']);
  assert.equal(buttons.find(b => b.url)?.label, '🔗 OpenSea');
});

test('collectionInfoCard says the floor could not be determined (not "unavailable") when sold out with no OpenSea data, and drops Max per wallet', () => {
  const card = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 5000, maxPerWallet: 3, startTime: null, collection: null, soldOut: true, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.match(card.content, /Status: Sold out\. Floor price couldn't be determined from this contract\./);
  assert.equal(card.content.includes('Max per wallet'), false);
  assert.match(card.content, /Max supply: 5000/);
});

test('collectionInfoCard shows the real floor once sold out, when OpenSea has it', () => {
  const card = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: true, displayPrice: { eth: 0.3, usd: null, source: 'floor' }, stats: null, openSeaUrl: null,
  });
  assert.match(card.content, /Status: Sold out — floor 0\.3 ETH/);
});

test('collectionInfoCard suggests scheduling only when the detected opening time is still in the future', () => {
  const future = Math.floor(Date.now() / 1000) + 3_600;
  const past = Math.floor(Date.now() / 1000) - 3_600;

  const notYetOpen = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: future, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.deepEqual(flatButtons(notYetOpen.components).map(b => b.custom_id),
    ['flow:mintdetailscontinue', 'flow:schedulesuggest', 'flow:detailsrefresh', 'flow:cancel:ask']);
  assert.match(notYetOpen.content, /Opens:/);

  const alreadyOpen = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: past, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.equal(flatButtons(alreadyOpen.components).some(b => b.custom_id === 'flow:schedulesuggest'), false);
  assert.match(alreadyOpen.content, /Opened:/);
});

// Section AF -- mirrors telegramMenus.test.js's coverage. On-chain SeaDrop only ever exposes the
// ONE currently-configured stage (the Opens/Opened line above), so it can never say what's coming
// after that; drop carries OpenSea's own real stage data (null unless OpenSea tracks this contract).
test('collectionInfoCard shows the live and next OpenSea phase when drop data is available, and omits the section entirely when it is not', () => {
  const noDrop = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, drop: null, openSeaUrl: null,
  });
  assert.equal(noDrop.content.includes('Phases'), false);

  const withDrop = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
    drop: {
      isMinting: true, dropType: 'seadrop_v1_erc721', maxSupply: 100, openSeaUrl: null,
      activeStage: { uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceETH: 0.05, maxPerWallet: 5, stageType: 'public_sale' },
      nextStage: null,
      stages: [
        { uuid: 'a0', label: 'Allowlist', startTime: 1_699_900_000, endTime: 1_700_000_000, priceETH: 0, maxPerWallet: 2, stageType: 'presale' },
        { uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceETH: 0.05, maxPerWallet: 5, stageType: 'public_sale' },
      ],
    },
  });
  assert.match(withDrop.content, /### Phases \(via OpenSea\)/);
  assert.match(withDrop.content, /2 phases total/);
  assert.match(withDrop.content, /🟢 Live: Public sale — 0\.05 ETH · max 5\/wallet/);
  assert.equal(withDrop.content.includes('🔵 Next'), false);
  // Section AF -- an allowlist/GTD/FCFS stage has no on-chain proof this app can construct; this
  // button is the only path that actually works for those, shown whenever OpenSea confirms a
  // stage is live right now.
  assert.equal(flatButtons(noDrop.components).some(b => b.custom_id === 'flow:mintviaopensea'), false);
  assert.equal(flatButtons(withDrop.components).some(b => b.custom_id === 'flow:mintviaopensea'), true);
});

test('collectionInfoCard shows an upcoming OpenSea phase with a fallback label built from stage_type when the stage has no name', () => {
  const withNext = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: true,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
    drop: {
      isMinting: false, dropType: 'seadrop_v1_erc721', maxSupply: 100, openSeaUrl: null,
      activeStage: null,
      nextStage: { uuid: 'n1', label: null, startTime: 1_700_000_000, endTime: 1_700_100_000, priceETH: 0.05, maxPerWallet: 5, stageType: 'public_sale' },
      stages: [],
    },
  });
  assert.match(withNext.content, /🔵 Next: Public Sale — 0\.05 ETH · max 5\/wallet · opens/);
  assert.equal(withNext.content.includes('phases total'), false, 'must not show a phase count for a single-stage next-only drop');
  // Nothing is minting yet -- OpenSea has nothing to build a mint transaction against, so the
  // button stays hidden until activeStage is real, not merely because drop data exists at all.
  assert.equal(flatButtons(withNext.components).some(b => b.custom_id === 'flow:mintviaopensea'), false);
  // A phase that hasn't opened yet has nothing to mint against but IS schedulable -- OpenSea's own
  // response at the exact open time is what determines eligibility and price, live.
  assert.equal(flatButtons(withNext.components).some(b => b.custom_id === 'flow:scheduleviaopensea'), true);
});

test('collectionInfoCard never offers Schedule for OpenSea phase when there is no upcoming stage to schedule against', () => {
  const noDrop = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, drop: null, openSeaUrl: null,
  });
  assert.equal(flatButtons(noDrop.components).some(b => b.custom_id === 'flow:scheduleviaopensea'), false);
});

test('a sold-out collection shows no phases and no mint/schedule actions, even when OpenSea still hands back stale stage data for it', () => {
  const card = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: true, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: Math.floor(Date.now() / 1000) - 3_600, collection: null,
    soldOut: true, displayPrice: null, stats: null, openSeaUrl: 'https://opensea.io/assets/ethereum/0xabc',
    drop: {
      isMinting: true, dropType: 'seadrop_v1_erc721', maxSupply: 100, openSeaUrl: null,
      activeStage: { uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceETH: 0.05, maxPerWallet: 5, stageType: 'public_sale' },
      nextStage: null,
      stages: [
        { uuid: 'a0', label: 'Allowlist', startTime: 1_699_900_000, endTime: 1_700_000_000, priceETH: 0, maxPerWallet: 2, stageType: 'presale' },
        { uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceETH: 0.05, maxPerWallet: 5, stageType: 'public_sale' },
      ],
    },
  });
  assert.equal(card.content.includes('Phases'), false, 'phases section must not render once sold out');
  const ids = flatButtons(card.components).map(b => b.custom_id || b.url);
  assert.deepEqual(ids, ['flow:detailsrefresh', 'https://opensea.io/assets/ethereum/0xabc', 'flow:cancel:ask'],
    'only the info-only Refresh/OpenSea/Cancel actions remain -- no Mint Now, no OpenSea phase action, no Schedule for opening');
});

test('taskNameQuickPicks offers GTD/FCFS/PUBLIC and a custom option in one select, with an unverified-labels caveat', () => {
  const menu = taskNameQuickPicks();
  const options = selectComponent(menu.components).options;
  assert.deepEqual(options.map(o => o.value), ['GTD', 'FCFS', 'PUBLIC', 'custom']);
  assert.match(menu.content, /unverified/);
  assert.deepEqual(flatButtons(menu.components).map(b => b.custom_id), ['flow:cancel:ask']);
});

test('taskConfirmation states plainly that the bot executes unattended, not a reminder', () => {
  const confirm = taskConfirmation({
    name: 'GTD', contractAddress: '0xabc', chainLabel: 'Ethereum', walletLabel: 'main',
    mintTime: '2026-08-20T18:00:00.000Z', priceETH: 0.1, priceUnknown: false,
  });
  assert.match(confirm.content, /not a reminder/);
  assert.match(confirm.content, /GTD/);
  assert.match(confirm.content, /0\.1 per item/);
  assert.deepEqual(flatButtons(confirm.components).map(b => b.custom_id), ['flow:taskconfirm', 'flow:cancel:ask']);
});

test('collectionInfoCard omits the stats table entirely when stats is null, and renders an aligned floor/holders/minted/volume table -- never a market cap -- when it is not', () => {
  const noStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, stats: null, openSeaUrl: null,
  });
  assert.equal(noStats.content.includes('```'), false);
  assert.equal(noStats.content.includes('Floor'), false);

  const withStats = collectionInfoCard({
    contractAddress: '0xabc', chainLabel: 'Ethereum', chainSym: 'ETH', isSeaDrop: false, priceETH: 0.05, priceUnknown: false,
    maxSupply: 100, maxPerWallet: 1, startTime: null, collection: null, soldOut: false, displayPrice: null, openSeaUrl: null,
    stats: {
      floorPrice: 0.08, floorPriceSymbol: 'ETH', numOwners: 42, totalMinted: 55,
      marketCap: 4.4, volume: { oneDay: 1.2, sevenDay: 5.5, thirtyDay: null, allTime: 20 },
    },
  });
  assert.match(withStats.content, /```[\s\S]*Floor\s+0\.08 ETH[\s\S]*```/);
  assert.match(withStats.content, /Holders\s+42/);
  assert.match(withStats.content, /Minted\s+55\/100/);
  assert.match(withStats.content, /24h volume\s+1\.2 ETH/);
  assert.match(withStats.content, /7d volume\s+5\.5 ETH/);
  assert.equal(withStats.content.includes('30d'), false);
  assert.equal(withStats.content.includes('Market cap'), false);
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

// Section O -- Discord counterparts to menu:tasks/menu:snipers/menu:admin performing the same
// lookups /task list, /sniper list, and the dashboard's admin overview already do, instead of
// replying "use /task ..." etc. Mirrors the coverage bar tests/telegramMenus.test.js sets for the
// same three buttons on the other platform.

test('tasksMenu lists each task and offers Next but not Prev on page 1', () => {
  const page = tasksMenu({ page: 1, totalPages: 2, total: 3, items: [{ name: 'GTD', status: 'scheduled', mintTime: '2026-08-20T18:00:00.000Z', id: 'task-1' }] });
  assert.match(page.content, /GTD.*scheduled/);
  const buttons = flatButtons(page.components).map(b => b.custom_id);
  assert.ok(!buttons.includes('tasks:page:0'));
  assert.ok(buttons.includes('tasks:page:2'));
  assert.ok(buttons.includes('menu:mint'), 'offers a way to schedule a mint from the same screen');
});

test('tasksMenu says so plainly when there are no scheduled tasks', () => {
  const page = tasksMenu({ page: 1, totalPages: 1, total: 0, items: [] });
  assert.match(page.content, /No scheduled tasks/);
});

test('snipersMenu matches /sniper list\'s exact format and disclaimer', () => {
  const list = snipersMenu([{ label: 'Copy Cool Cats', active: true, id: 'sniper-1' }, { label: 'Old one', active: false, id: 'sniper-2' }]);
  assert.match(list.content, /Post-confirmation copying only; not mempool front-running/);
  assert.match(list.content, /Copy Cool Cats \[active\] — sniper-1/);
  assert.match(list.content, /Old one \[inactive\] — sniper-2/);

  const empty = snipersMenu([]);
  assert.match(empty.content, /No matching snipers/);
  assert.ok(flatButtons(list.components).some(b => b.custom_id === 'sniper:create:start'));
  assert.ok(flatButtons(empty.components).some(b => b.custom_id === 'sniper:create:start'));
});

test('sniperDetailsModal asks for both label and target address, both required', () => {
  const modal = sniperDetailsModal();
  assert.equal(modal.custom_id, 'flow:snipercreate:submit');
  const fields = modal.components.map(r => r.components[0]);
  assert.deepEqual(fields.map(f => f.custom_id), ['label', 'targetAddress']);
  assert.ok(fields.every(f => f.required === true));
});

test('sniperTolerancePrompt shows every default and offers accept-defaults alongside set-my-own', () => {
  const prompt = sniperTolerancePrompt({ maxGasGwei: 200, maxValueETH: 0.1, dailySpendingCapETH: 0.25 });
  assert.match(prompt.content, /max gas \*\*200 gwei\*\*/);
  assert.match(prompt.content, /max value per fire \*\*0\.1 ETH\*\*/);
  assert.match(prompt.content, /daily spend cap \*\*0\.25 ETH\*\*/);
  assert.deepEqual(flatButtons(prompt.components).map(b => b.custom_id), ['flow:snipertoleranceaccept', 'flow:snipertolerancemanual']);
});

test('sniperToleranceModal offers all three fields as optional, showing the default in each placeholder', () => {
  const modal = sniperToleranceModal({ maxGasGwei: 200, maxValueETH: 0.1, dailySpendingCapETH: 0.25 });
  const fields = modal.components.map(r => r.components[0]);
  assert.deepEqual(fields.map(f => f.custom_id), ['maxGasGwei', 'maxValueETH', 'dailySpendingCapETH']);
  assert.ok(fields.every(f => f.required === false));
  assert.match(fields[0].placeholder, /200/);
  assert.match(fields[1].placeholder, /0\.1/);
  assert.match(fields[2].placeholder, /0\.25/);
});

test('sniperConfirmation shows every field, naming defaults explicitly rather than a blank', () => {
  const withCustom = sniperConfirmation({ label: 'Whale copy', targetAddress: '0xabc', chain: 'ethereum', walletLabel: 'main', maxGasGwei: 80 });
  assert.match(withCustom.content, /Whale copy/);
  assert.match(withCustom.content, /Max gas: 80/);
  assert.match(withCustom.content, /Max value\/fire: default \(0\.1 ETH\)/);
  assert.match(withCustom.content, /Daily cap: default \(0\.25 ETH\)/);
  assert.deepEqual(flatButtons(withCustom.components).map(b => b.custom_id), ['flow:sniperconfirm', 'flow:cancel:ask']);
});

test('adminOverviewMenu shows metrics and per-group ceilings, wording "no ceiling" for a null value', () => {
  const overview = adminOverviewMenu({
    metrics: { totalUsers: 10, activeAnyPlatform24h: 4, owners: 2, rootOwners: 1, groups: 2, linkedAccounts: 6 },
    groups: [
      { name: 'Standard', gasCeilingGwei: 50, maxTransactionValueEth: '0.5', dailySpendingBudgetEth: '2.0' },
      { name: 'Unlimited', gasCeilingGwei: null, maxTransactionValueEth: null, dailySpendingBudgetEth: null },
    ],
  });
  assert.match(overview.content, /10 total/);
  assert.match(overview.content, /2 owners \(1 root\)/);
  assert.match(overview.content, /Standard.*gas ≤50 gwei, tx ≤0\.5, daily ≤2\.0/);
  assert.match(overview.content, /Unlimited.*no ceiling.*no ceiling.*no ceiling/);
});

test('adminOverviewMenu says so plainly when no groups are configured yet', () => {
  const overview = adminOverviewMenu({ metrics: { totalUsers: 1, activeAnyPlatform24h: 0, owners: 1, rootOwners: 1, groups: 0, linkedAccounts: 0 }, groups: [] });
  assert.match(overview.content, /No groups configured yet/);
  assert.match(overview.content, /1 owner \(1 root\)/, 'singular "owner" when the count is exactly 1');
});
