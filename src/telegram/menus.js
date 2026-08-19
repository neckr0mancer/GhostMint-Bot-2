// Pure menu-building functions for the Milestone 15a/15b Telegram redesign. Nothing here talks
// to a bot, a database, or the transaction engine — every function takes plain data in and
// returns a { text, replyMarkup, parseMode } payload, which keeps this module trivially
// unit-testable and keeps server.js (the composition root) responsible only for wiring, not UI
// layout. Every returned text uses Telegram's HTML parse mode (<b>/<code>, never legacy
// *asterisk*/`backtick` Markdown) since that's the only mode server.js's tg* senders use -- any
// free-text value a user typed (a wallet label, a task name) is escaped with escapeTelegramHtml
// before being interpolated next to a real tag so it can never break or inject into the markup.

const { escapeTelegramHtml } = require('../security/botSecurity');

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

// A link button opens directly in the user's browser -- Telegram distinguishes it from a regular
// button by carrying `url` instead of `callback_data`, and it never reaches this bot's callback
// handler at all.
function urlButton(text, url) {
  return { text, url };
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

// Also reachable from Settings ("Link another platform") -- same callback_data, same
// createLinkCode() call underneath. Putting it on the main menu too just cuts the common case
// from two taps to one; it doesn't change what the code does or its security properties (still
// single-use, still expires in five minutes, still Telegram-only origin per Milestone 15e).
function mainMenu({ isOwner = false } = {}) {
  const rows = [
    [button('👛 Wallets', 'menu:wallets'), button('⚡ Mint', 'menu:mint')],
    [button('💸 Send', 'menu:send')],
    [button('🗓️ Tasks', 'menu:tasks'), button('🎯 Snipers', 'menu:snipers')],
    [button('📡 Watch rules', 'menu:watch'), button('📊 Activity', 'menu:activity')],
    [button('⛽ Gas', 'menu:gas'), button('⚙️ Settings', 'menu:settings')],
    [button('🔗 Link Discord or dashboard', 'link:generate')],
  ];
  if (isOwner) rows.push([button('🛡️ Admin', 'menu:admin')]);
  return {
    text: '<b>👻 GhostMint</b>\n\nWagmi HQ. Pick your lane below, or fire a command straight in if you already know the drill.',
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function walletsMenu() {
  return {
    text: '<b>👛 Wallets</b>\n\nA fresh wallet minted server-side beats importing your seed phrase from a sticky note. We recommend generating new.',
    replyMarkup: keyboard([
      [button('📋 List wallets', 'wallet:list')],
      [button('➕ Create wallet', 'wallet:create:start')],
      [button('📥 Import wallet', 'wallet:import:start')],
      [button('💰 Check balance', 'wallet:balance:pick')],
      [button('🔑 Export key', 'menu:exportkey')],
      [button('🗑️ Remove wallet', 'wallet:remove:pick')],
      [button('⬅️ Back to base', 'menu:main')],
    ]),
    parseMode: 'HTML',
  };
}

function settingsMenu({ isOwner = false } = {}) {
  const rows = [
    [button('🔗 Link another platform', 'link:generate')],
    [button('🎛️ Transaction mode', 'menu:mode')],
  ];
  if (isOwner) rows.push([button('🛡️ Admin console', 'menu:admin')]);
  rows.push([button('⬅️ Back to base', 'menu:main')]);
  return { text: '<b>⚙️ Settings</b>\n\nRun it your way.', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// title/hint are always literal strings the developer wrote at the call site (never user input),
// and a couple of call sites already hand-escape a literal placeholder like "&lt;id&gt;" into
// hint themselves -- so neither is run through escapeTelegramHtml here, which would double-escape
// those entities.
function placeholderMenu(title, hint) {
  return {
    text: `<b>${title}</b>\n\n${hint}`,
    replyMarkup: keyboard([[button('⬅️ Back to base', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

// Telegram bot text can't embed real custom icons inline -- only Unicode renders inline with a
// button label or a line of text, so this is the closest Telegram gets to the per-chain brand
// marks src/discord/menus.js now uploads as real application emoji. Same picks as Discord's own
// pre-upload Unicode fallback, kept here for whichever chain buttons never get an image treatment.
const CHAIN_EMOJI = { ethereum: '💎', base: '🔵', arbitrum: '🔷', polygon: '🟣', robinhood: '🟢' };

function chainButtonLabel(chain, chains) {
  const emoji = CHAIN_EMOJI[chain];
  return `${emoji ? `${emoji} ` : ''}${chains[chain]?.name || chain}`;
}

function chainPicker(supportedChains, chains, { prefix = 'flow:chain' } = {}) {
  const rows = supportedChains.map(chain => [button(chainButtonLabel(chain, chains), `${prefix}:${chain}`)]);
  rows.push([button('❌ Nah, cancel', 'flow:cancel:ask')]);
  return { text: 'Pick your chain, ser:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function walletPicker(wallets, { prefix, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const rows = wallets.map(wallet => [button(`${wallet.label} (${wallet.chain})`, `${prefix}:${wallet.label}`)]);
  rows.push([button('⬅️ Back to wallets', 'menu:wallets')]);
  return { text: 'Which wallet is riding this one?', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// Multi-select variant for /batch: tapping a wallet toggles it (re-renders this same menu with the
// updated checkmark), Continue only appears once at least one wallet is selected.
function walletMultiPicker(wallets, selectedLabels, { emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const rows = wallets.map(wallet => {
    const checked = selectedLabels.includes(wallet.label);
    return [button(`${checked ? '✅' : '⬜'} ${wallet.label} (${wallet.chain})`, `flow:wallettoggle:${wallet.label}`)];
  });
  if (selectedLabels.length) {
    rows.push([button(`▶️ Squad's set, continue with ${selectedLabels.length} wallet${selectedLabels.length === 1 ? '' : 's'}`, 'flow:walletcontinue')]);
  }
  rows.push([button('❌ Nah, cancel', 'flow:cancel:ask')]);
  return { text: 'Tap every wallet you want in this batch, then hit Continue:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function sendConfirmation({ walletLabel, toAddress, chainLabel, amountETH, sym, estimatedGasETH, totalETH }) {
  return {
    text: `<b>🚀 Confirm send</b>\nFrom: ${escapeTelegramHtml(walletLabel)}\nTo: <code>${toAddress}</code>\nChain: ${chainLabel}\nAmount: ${amountETH} ${sym}\nEstimated gas: ~${estimatedGasETH} ${sym}\nTotal: ~${totalETH} ${sym}\n\nSend it, ser?`,
    replyMarkup: keyboard([[button('✅ Send it', 'flow:sendconfirm')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Deliberately not a bare "Confirm" -- this is the one place in the app where under-promising is
// the correct product decision. The warning has to say the timer is a courtesy, not a control,
// because it is: the key still transits Telegram's servers and can be screenshotted or forwarded
// before it fires.
function exportKeyWarning({ walletLabel }) {
  return {
    text: `⚠️ <b>Export the private key for ${escapeTelegramHtml(walletLabel)}?</b>\n\nThis is the master key to this wallet's bag. Whoever holds it owns everything in it, permanently, no takebacks. The message auto-deletes shortly, but that's a courtesy, not a control: the key still transits Telegram's servers and can be screenshotted or forwarded before the timer fires. Only proceed if you fully understand what you're holding.`,
    replyMarkup: keyboard([[button('⚠️ I understand, export it', 'flow:exportconfirm')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// A real USD figure of $0 is possible (a genuinely worthless floor) and must render as $0.00, not
// be dropped -- only a missing/unpriced feed (null) omits the suffix entirely.
function usdSuffix(usd) {
  return usd === null || usd === undefined ? '' : ` (~$${usd.toFixed(2)})`;
}

// Shown once, right after a contract address resolves to a chain -- before wallet selection --
// so "what is this thing" is answered up front instead of being buried inside the final confirm
// screen. collection (OpenSea metadata) and startTime/endTime (SeaDrop only) are both optional:
// a plain mint(uint256) contract or an unconfigured OpenSea key just renders fewer lines, never an
// error. displayPrice/soldOut (botCommandService.js's detectMintContract) drive which price this
// shows -- the still-minting mint price, or once sold out, OpenSea's floor (including a genuine
// floor of exactly 0, which is a real value here, not "unavailable") -- but priceETH/priceUnknown
// below are untouched: they always describe what an actual mint transaction would spend, never a
// secondary-market reference figure.
function contractDetailsText({ contractAddress, chainLabel, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice }) {
  // collection (OpenSea metadata) is untrusted third-party data, not a hardcoded literal -- escape
  // both name and description before they land in the same text as real <b> tags.
  // Blank lines below group the card into identity / price / limits / description bands instead of
  // one flat run-on list -- Telegram has no layout primitives beyond line breaks, so spacing IS the
  // only alignment tool available here.
  const lines = [
    collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>📜 The Deets</b>',
    `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];
  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out. Floor's sitting at ${displayPrice.eth} ETH${usdSuffix(displayPrice.usd)}`
      : "Status: Sold out. Floor price couldn't be determined from this contract.");
  } else {
    lines.push(priceUnknown
      ? "Price: not determinable from this contract, so you'll enter it yourself"
      : `Price: ${priceETH} per item${displayPrice ? usdSuffix(displayPrice.usd) : ''}`);
  }
  const limits = [];
  // Once sold out there's nothing left to mint -- a per-wallet mint cap has nothing left to apply
  // to (trading moves to secondary from here), so it drops off rather than sitting there as a
  // number that's no longer actionable. Max supply stays: unlike the cap, it's a permanent fact
  // about the collection's final size, not a mint-time-only concept.
  if (!soldOut && maxPerWallet !== null && maxPerWallet !== undefined) limits.push(`Max per wallet: ${maxPerWallet}`);
  if (maxSupply !== null && maxSupply !== undefined) limits.push(`Max supply: ${maxSupply}`);
  if (startTime) {
    const opensAt = formatGmtPlus1(startTime * 1000);
    limits.push(startTime * 1000 > Date.now() ? `Opens: ${opensAt}` : `Opened: ${opensAt}`);
  }
  if (limits.length) lines.push('', ...limits);
  if (collection?.description) lines.push('', escapeTelegramHtml(collection.description.slice(0, 300)));
  return lines.join('\n');
}

// Still used by task_guided's own awaiting_details + Continue step (Section B's schedule flow) --
// mint_guided no longer shows this as a standalone screen (Section M folds contractDetailsText
// into whatever the first actionable mint screen turns out to be instead), but the schedule flow
// is unchanged and still wants a plain details-then-Continue screen.
function contractDetails(data) {
  return {
    text: contractDetailsText(data),
    replyMarkup: keyboard([[button('▶️ Continue', 'flow:mintdetailscontinue')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Rounds to 4 decimal places for display -- enough precision to distinguish real mint/floor
// prices without spilling a raw wei-derived float's trailing digits onto the card.
function formatEthAmount(value, sym) {
  if (value === null || value === undefined) return null;
  return `${Math.round(value * 10_000) / 10_000} ${sym || 'ETH'}`;
}

// Fixed UTC+1 offset for display only -- deliberately not a DST-aware zone, so this never drifts
// between GMT+1 and GMT+2 across the year. Every stored/scheduled instant (task.mintTime, the
// scheduler's own clock, startTime from the contract) stays true UTC; this only reformats what the
// user reads on screen, so shifting it can never change when a mint actually fires.
function formatGmtPlus1(value) {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() + 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} GMT+1`;
}

// Section AD Tier 1: the collection info card mint_guided's first screen renders instead of the
// old merged-details-header (Section M) -- market cap, live floor, and volume alongside the
// existing mint-specific fields, with "🪙 Mint Now" as one of several actions (Refresh, Copy CA,
// View on OpenSea) rather than the screen's only purpose. stats is null until
// detectMintContract has been called with includeStats:true (server.js's job, not this file's);
// every stats-derived line is simply omitted rather than shown as a placeholder when a field is
// unavailable, the same "unknown is fine" convention contractDetailsText above already uses.
// openSeaUrl is built by the caller (server.js, from OPENSEA_CHAIN_SLUGS) rather than here, so
// this module stays free of a cross-directory import into src/mint/ -- null omits the button
// entirely rather than linking to a chain OpenSea doesn't index.
function collectionInfoCard({ contractAddress, chainLabel, chainSym, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice, stats, openSeaUrl }) {
  const sym = chainSym || 'ETH';
  // Blank lines below group the card into identity / price / stats / limits / description bands --
  // Telegram has no layout primitives beyond line breaks, so spacing IS the only alignment tool
  // available here.
  const lines = [
    collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>📜 The Deets</b>',
    `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];

  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out. Floor's at ${displayPrice.eth} ${sym}${usdSuffix(displayPrice.usd)}`
      : "Status: Sold out. Floor price couldn't be determined from this contract.");
  } else {
    lines.push(priceUnknown ? "Mint price: not exposed by this contract. You're flying manual" : `Mint price: ${priceETH} ${sym} per item`);
  }

  // Real column alignment (not just eyeballed spaces) needs a monospace run, which Telegram only
  // gives inside <pre> -- padEnd against the widest label in THIS card's actual rows, not a fixed
  // width, so a card with just "Floor" doesn't carry three columns of dead padding.
  // Market cap is deliberately not a row here: stats.marketCap is floor price * totalMinted, a
  // derived number that dresses up the same floor price already shown above as if it were a
  // second, independent metric. Floor stays the one number that matters.
  if (stats) {
    const statRows = [];
    const floor = formatEthAmount(stats.floorPrice, stats.floorPriceSymbol || sym);
    if (floor) statRows.push(['Floor', floor]);
    if (stats.numOwners !== null && stats.numOwners !== undefined) statRows.push(['Holders', String(stats.numOwners)]);
    if (stats.totalMinted !== null && stats.totalMinted !== undefined) {
      statRows.push(['Minted', maxSupply ? `${stats.totalMinted}/${maxSupply}` : String(stats.totalMinted)]);
    }
    const volume = stats.volume || {};
    if (volume.oneDay !== null && volume.oneDay !== undefined) statRows.push(['24h volume', formatEthAmount(volume.oneDay, sym)]);
    if (volume.sevenDay !== null && volume.sevenDay !== undefined) statRows.push(['7d volume', formatEthAmount(volume.sevenDay, sym)]);
    if (volume.thirtyDay !== null && volume.thirtyDay !== undefined) statRows.push(['30d volume', formatEthAmount(volume.thirtyDay, sym)]);
    if (statRows.length) {
      const labelWidth = Math.max(...statRows.map(([label]) => label.length));
      const table = statRows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`).join('\n');
      lines.push('', '📈 <b>Stats</b>', `<pre>${table}</pre>`);
    }
  }

  const limits = [];
  // Once sold out there's nothing left to mint -- a per-wallet mint cap has nothing left to apply
  // to (trading moves to secondary from here), so it drops off rather than sitting there as a
  // number that's no longer actionable. Max supply stays: unlike the cap, it's a permanent fact
  // about the collection's final size, not a mint-time-only concept.
  if (!soldOut && maxPerWallet !== null && maxPerWallet !== undefined) limits.push(`Max per wallet: ${maxPerWallet}`);
  if (maxSupply !== null && maxSupply !== undefined) limits.push(`Max supply: ${maxSupply}`);
  // Not live yet: "Mint Now" would just revert against a stage that hasn't opened, so scheduling is
  // offered as its own action right here rather than only reachable after a failed attempt.
  const opensInFuture = Boolean(startTime && startTime * 1000 > Date.now());
  if (startTime) {
    const opensAt = formatGmtPlus1(startTime * 1000);
    limits.push(opensInFuture ? `Opens: ${opensAt}` : `Opened: ${opensAt}`);
  }
  if (limits.length) lines.push('', ...limits);
  if (collection?.description) lines.push('', escapeTelegramHtml(collection.description.slice(0, 300)));

  const utilityRow = [button('🔄 Refresh', 'flow:detailsrefresh')];
  if (openSeaUrl) utilityRow.push(urlButton('🔗 OpenSea', openSeaUrl));

  const rows = [[button('🪙 Ape In Now', 'flow:mintdetailscontinue')]];
  if (opensInFuture) rows.push([button('📅 Schedule for opening', `flow:schedulesuggest:${contractAddress}`)]);
  rows.push(utilityRow, [button('📋 Copy CA', 'flow:copyca')], [button('❌ Nah, cancel', 'flow:cancel:ask')]);

  return {
    text: lines.join('\n'),
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// phaseNumber > 1 means this task is a later stage of a multi-stage drop (Section AF). Its price and
// time were typed by hand off the project's own announcement -- nothing on-chain describes a stage
// that isn't live yet -- so the price line must not claim the contract said so.
function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, quantity, mintTime, autoDetectedTime, priceETH, priceUnknown, displayPrice, phaseNumber }) {
  const phase = Number(phaseNumber) > 1 ? Number(phaseNumber) : null;
  let priceLine;
  if (phase) priceLine = `Price: ${priceETH} per item (your number for this phase)`;
  else if (priceUnknown) priceLine = 'Price: not exposed by this contract. Using the amount you punched in above.';
  else priceLine = `Price: ${priceETH} per item (straight from the contract)${displayPrice ? usdSuffix(displayPrice.usd) : ''}`;
  const timeLine = autoDetectedTime
    ? `Fires: <b>${formatGmtPlus1(mintTime)}</b> (this contract's own opening time)`
    : `Fires: <b>${formatGmtPlus1(mintTime)}</b>`;
  const heading = phase ? `<b>⏰ Confirm phase ${phase}</b>` : '<b>⏰ Confirm scheduled mint</b>';
  return {
    text: `${heading}\nName: ${escapeTelegramHtml(name)}\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet: ${escapeTelegramHtml(walletLabel)}\nQuantity: ${quantity || 1}\n${priceLine}\n${timeLine}\n\nThis is not a reminder — the bot signs and sends the mint itself at that moment, phone in your pocket, you asleep.\n\nLock it in?`,
    replyMarkup: keyboard([[button('✅ Schedule it', 'flow:taskconfirm')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Success screen for a created task, and the whole point of Section AF: a drop with several stages
// has no on-chain schedule to read (SeaDrop's PublicDrop is one mutable struct describing only the
// stage that is live right now), so the only way to pre-arm every stage is one task per stage, each
// with its own hand-entered time and price. Offering that as the obvious next tap is the feature --
// the contract address rides in the callback data so the next phase skips straight past re-pasting.
function taskScheduled({ name, contractAddress, mintTime, phaseNumber }) {
  const phase = Number(phaseNumber) > 1 ? Number(phaseNumber) : 1;
  const armed = phase > 1
    ? `✅ Phase ${phase} armed: <b>${escapeTelegramHtml(name)}</b>`
    : `✅ Locked in: <b>${escapeTelegramHtml(name)}</b>`;
  return {
    text: `${armed}\nFires: <b>${formatGmtPlus1(mintTime)}</b>\n\nGot another public stage on this drop? Different time, different price — stack one task per stage and the bot works down the list. Allowlist/GTD stages need a per-wallet proof this bot can't fetch yet, so those aren't schedulable.`,
    replyMarkup: keyboard([
      [button(`➕ Add phase ${phase + 1}`, `flow:phase:${phase + 1}:${contractAddress}`)],
      [button('🗓️ See all tasks', 'menu:tasks')],
      [button('⬅️ Back to base', 'menu:main')],
    ]),
    parseMode: 'HTML',
  };
}

// Groups chain-switch buttons 3-per-row so the keyboard stays compact regardless of how many
// chains are configured, rather than one button per row like the flow-only chainPicker above.
function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function gasMenu(chain, fees, supportedChains, chains) {
  const chainButtons = supportedChains.map(value => button(chainButtonLabel(value, chains), `gas:chain:${value}`));
  const rows = chunk(chainButtons, 3);
  rows.push([button('⬅️ Back to base', 'menu:main')]);
  const readout = fees
    ? `Safe: <b>${fees.safeGasPriceGwei ?? 'unavailable'}</b> Gwei\nStandard: <b>${fees.gasPriceGwei ?? 'unavailable'}</b> Gwei\nFast: <b>${fees.maxFeePerGasGwei ?? 'unavailable'}</b> Gwei`
    : "Couldn't fetch gas prices for this chain. The network's ghosting us.";
  return {
    text: `⛽ <b>Gas check: ${escapeTelegramHtml(chains[chain]?.name || chain)}</b>\nReal-time, no cap.\n${readout}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// Live-reported: this used to be a static instructional placeholder pointing at /tasks,
// /canceltask, /pausetask, /resumetask, /retrytask <id> instead of an actual list -- the same
// command-line-only gap Section O already closed for wallets, watch rules and snipers. Mirrors
// watchRulesList's shape: one row per task, with a Cancel button directly beside it whenever
// cancel is actually valid for the task's current status (schedulerRepository.cancel only accepts
// scheduled/retry/paused, so a claimed/failed/completed task gets no dead Cancel button). Tapping
// the task itself opens taskActions() below for the full detail and every other status-appropriate
// action, matching watchRuleActions' depth.
const CANCELLABLE_TASK_STATUSES = new Set(['scheduled', 'retry', 'paused']);

function tasksMenu(page) {
  const tasks = page?.items ?? [];
  if (!tasks.length) {
    return {
      text: '<b>🗓️ Tasks</b>\n\nSchedule a mint to fire automatically the moment it\'s go time.',
      replyMarkup: keyboard([[button('🗓️ Schedule mint', 'menu:schedule')], [button('⬅️ Back to base', 'menu:main')]]),
      parseMode: 'HTML',
    };
  }
  const rows = tasks.map(task => {
    const shortName = task.name.length > 28 ? `${task.name.slice(0, 27)}…` : task.name;
    const row = [button(`⏱ ${shortName} [${task.status}]`, `task:manage:${task.id}`)];
    if (CANCELLABLE_TASK_STATUSES.has(task.status)) row.push(button('❌', `task:cancel:ask:${task.id}`));
    return row;
  });
  const nav = [];
  if (page.page > 1) nav.push(button('◀️ Prev', `task:page:${page.page - 1}`));
  if (page.page < page.totalPages) nav.push(button('▶️ Next', `task:page:${page.page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('🗓️ Schedule mint', 'menu:schedule')]);
  rows.push([button('⬅️ Back to base', 'menu:main')]);
  return {
    text: `<b>🗓️ Tasks (page ${page.page}/${page.totalPages}, ${page.total} total)</b>`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function taskActions(task) {
  const rows = [];
  if (task.status === 'scheduled' || task.status === 'retry') rows.push([button('⏸ Pause', `task:pause:${task.id}`)]);
  if (task.status === 'paused') rows.push([button('▶️ Resume', `task:resume:${task.id}`)]);
  if (task.status === 'failed') rows.push([button('↻ Retry', `task:retry:${task.id}`)]);
  if (CANCELLABLE_TASK_STATUSES.has(task.status)) rows.push([button('❌ Cancel', `task:cancel:ask:${task.id}`)]);
  rows.push([button('⬅️ Back to the list', 'menu:tasks')]);
  return {
    text: `<b>${escapeTelegramHtml(task.name)}</b> [${task.status}]\nContract: <code>${task.contract}</code>\nWallet: ${escapeTelegramHtml(task.walletLabel)}\nQty: ${task.qty} | Price: ${task.price > 0 ? `${task.price} ETH` : 'Free'}\nDue: <b>${formatGmtPlus1(task.mintTime)}</b>\nID: <code>${task.id}</code>`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function confirmCancelTask(task) {
  return {
    text: `Cancel <b>${escapeTelegramHtml(task.name)}</b>? This cannot be undone.`,
    replyMarkup: keyboard([
      [button('✅ Yes, cancel it', `task:cancel:do:${task.id}`)],
      [button('❌ No, keep it', `task:manage:${task.id}`)],
    ]),
    parseMode: 'HTML',
  };
}

// Section O -- performs the same lookup /snipers already does, matching its exact list format
// (Post-confirmation copying disclaimer included) rather than replying "use /snipers".
function sniperMenu(snipers) {
  if (!snipers.length) {
    return {
      text: '<b>🎯 Snipers</b>\n\nNo snipers configured.\n<i>Post-confirmation copy snipers replicate a target wallet\'s confirmed mint from one of yours -- not mempool front-running.</i>',
      replyMarkup: keyboard([[button('⬅️ Back to base', 'menu:main')]]),
      parseMode: 'HTML',
    };
  }
  const list = snipers.map(s =>
    `${s.active ? '🟢' : '⚪'} <b>${escapeTelegramHtml(s.label)}</b>\nTarget: <code>${s.targetAddress.slice(0, 10)}...</code>\nChain: ${s.chain} · Wallet: ${escapeTelegramHtml(s.walletLabel)}\nHits: ${s.hits || 0} · Fails: ${s.fails || 0}`,
  ).join('\n\n');
  return {
    text: `<b>🎯 Post-confirmation copy snipers (${snipers.length})</b>\n<i>Not mempool front-running: copying begins only after the source transaction confirms.</i>\n\n${list}`,
    replyMarkup: keyboard([[button('⬅️ Back to base', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

// Section O -- performs the same lookup /activity already does, with Prev/Next paging (no Prev on
// page 1, no Next once the last page is reached) instead of requiring the page number be typed.
function activityMenu(page) {
  const lines = page.items.length
    ? page.items.map(a => {
        const icon = a.status === 'success' ? '✅' : '❌';
        const tx = a.txHash ? `\n   <a href="${a.explorer}${a.txHash}">View tx</a>` : '';
        return `${icon} ${escapeTelegramHtml(a.title)} · <b>${escapeTelegramHtml(a.walletLabel)}</b>\n   ${new Date(a.time).toLocaleString()}${tx}`;
      }).join('\n\n')
    : 'No activity yet.';
  const nav = [];
  if (page.page > 1) nav.push(button('◀️ Prev', `activity:page:${page.page - 1}`));
  if (page.page < page.totalPages) nav.push(button('▶️ Next', `activity:page:${page.page + 1}`));
  const rows = nav.length ? [nav] : [];
  rows.push([button('⬅️ Back to base', 'menu:main')]);
  return {
    text: `<b>📋 Activity (page ${page.page}/${page.totalPages}, ${page.total} total)</b>\n\n${lines}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// Section O -- /admin itself is a write-only dispatcher over 20+ owner actions with no single
// "the" read to mirror, so this instead surfaces governance.dashboardOverview (already built and
// already owner-gated -- the same data the web dashboard's own admin page shows), which is a much
// more useful glance than the old placeholder ever was. Per-user detail and preset tuning stay on
// the dashboard/CLI-style commands; this is a summary, not a full admin console. Wei figures are
// formatted to ETH strings by the caller (server.js) so this module stays free of an ethers import,
// same as every other menu function here that only ever receives display-ready numbers.
function adminOverviewMenu({ metrics, groups }) {
  const groupLines = groups.length
    ? groups.map(g => `• <b>${escapeTelegramHtml(g.name)}</b> — gas ≤${g.gasCeilingGwei ?? 'no ceiling'} gwei, tx ≤${g.maxTransactionValueEth ?? 'no ceiling'}, daily ≤${g.dailySpendingBudgetEth ?? 'no ceiling'}`).join('\n')
    : 'No groups configured yet.';
  return {
    text: `<b>🛡️ Admin overview</b>\n`
      + `Users: ${metrics.totalUsers} total · ${metrics.activeAnyPlatform24h} active in 24h · ${metrics.owners} owner${metrics.owners === 1 ? '' : 's'} (${metrics.rootOwners} root)\n`
      + `Groups: ${metrics.groups} · Linked accounts: ${metrics.linkedAccounts}\n\n`
      + `<b>Groups</b>\n${groupLines}\n\n`
      + `Per-user detail and every other action: /admin &lt;action&gt; ... CONFIRM.`,
    replyMarkup: keyboard([[button('⬅️ Back to base', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

// Same 4 presets/labels as Discord's /mode choices (discordBot.js) -- kept in sync by hand since
// the two platforms build their option lists in entirely different shapes (inline keyboard vs.
// slash-command choices).
const MODE_META = {
  ultra_fast: { label: 'Degen', hint: 'full send, high gas, zero confirmations, no brakes' },
  fast: { label: 'Fast', hint: 'quick, higher gas, still asks before it fires' },
  semi_safe: { label: 'Cautious', hint: 'measured, moderate gas' },
  safe: { label: 'Normie', hint: 'slow and steady, network-price gas, zero surprises' },
};

// Must match ADVANCED_PRESET_KEYS in src/governance/postgresGovernanceRepository.js -- the
// backend is the real gate (selectPreset rejects these for an ineligible caller regardless of
// what's offered here); this list only avoids offering a doomed tap in the first place.
const GATED_PRESET_KEYS = ['ultra_fast', 'fast'];

function modeMenu(currentKey, presets, advancedModesAllowed = false) {
  const rows = presets
    .filter(preset => advancedModesAllowed || !GATED_PRESET_KEYS.includes(preset.key))
    .map(preset => {
      const meta = MODE_META[preset.key] || { label: preset.displayName, hint: '' };
      return [button(`${preset.key === currentKey ? '✅ ' : ''}${meta.label} · ${meta.hint}`, `mode:pick:${preset.key}`)];
    });
  rows.push([button('⬅️ Back to settings', 'menu:settings')]);
  const currentLabel = MODE_META[currentKey]?.label || 'none selected';
  const lockedNote = advancedModesAllowed ? '' : '\n\n🔒 Degen and Fast require group or admin access.';
  return {
    text: `<b>🎛️ Transaction mode</b>\n\nCurrent vibe: <b>${escapeTelegramHtml(currentLabel)}</b>\n\nControls confirmation prompts and how hard this thing sends gas on every mint. Ceilings and forced simulation always have the final say, no matter which mode you pick.${lockedNote}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function mintConfirmation({ contractAddress, chainLabel, walletLabels, quantity = 1, priceETH, priceUnknown, maxGasGwei }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract. Using the amount you entered above.'
    : `Price: ${priceETH} per item (straight from the contract)`;
  // maxGasGwei only ever appears here for a batch (see afterGasToleranceResolved) -- undefined
  // means this confirm screen isn't reachable through that step at all (a plain /mint), so the
  // line is omitted entirely rather than shown as "not set" for a flow that was never asked.
  const gasLine = maxGasGwei === undefined ? '' : `\nGas tolerance: ${maxGasGwei === null ? 'no extra limit (account ceiling only)' : `up to ${maxGasGwei} gwei`}`;
  return {
    text: `<b>🪙 Confirm mint</b>\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet(s): ${walletLabels.map(escapeTelegramHtml).join(', ')}\nQuantity: ${quantity} each\n${priceLine}${gasLine}\n\nLocked in?`,
    replyMarkup: keyboard([[button('✅ Send it', 'flow:mintconfirm')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Section [gas tolerance] -- /batch's extra step between wallet selection and confirm (see
// mintFlowDecision.afterPriceKnown): lets the user cap what THIS batch is willing to pay in gas
// without touching their account's own governance gas ceiling (shown here for context, and never
// raised by this choice -- only ever tightened further, enforced in transactionEngine.submit
// alongside the existing ceiling check). Mirrors mintPriceStep's accept/manual two-button shape.
function gasTolerancePrompt({ currentGasGwei, ceilingGwei }) {
  const currentLine = currentGasGwei === null || currentGasGwei === undefined
    ? "Current network gas price is MIA right now."
    : `Current network gas price: <b>${currentGasGwei} gwei</b>.`;
  return {
    text: `<b>⛽ Gas tolerance for this batch</b>\n${currentLine}\nYour account's gas ceiling: <b>${ceilingGwei} gwei</b> (this batch will never blow past it).\n\nWant a tighter leash just for this batch? Any wallet whose tx would exceed it gets skipped, not sent. No rugging your own gas budget.`,
    replyMarkup: keyboard([
      [button(`✅ No extra limit (up to ${ceilingGwei} gwei)`, 'flow:gastoleranceaccept')],
      [button('✏️ Set my own gwei cap', 'flow:gastolerancemanual')],
      [button('❌ Nah, cancel', 'flow:cancel:ask')],
    ]),
    parseMode: 'HTML',
  };
}

// Watch-rule guided create flow (mirrors src/social/watchRuleFlowDecision.js's step ordering).
const WATCH_TYPE_META = {
  twitter_account: { label: '🐦 Twitter · Account', hint: 'watch everything one X/Twitter account posts' },
  twitter_keyword: { label: '🐦 Twitter · Keyword', hint: 'watch X/Twitter for matching keywords' },
  discord_channel: { label: '💬 Discord · Channel', hint: 'watch every message in one Discord channel' },
  discord_keyword: { label: '💬 Discord · Keyword', hint: 'watch Discord for matching keywords' },
  farcaster_account: { label: '🟣 Farcaster · Account', hint: 'watch everything one Farcaster account casts' },
  farcaster_keyword: { label: '🟣 Farcaster · Keyword', hint: 'watch Farcaster for matching keywords' },
};
const WATCH_METHOD_META = {
  official_api: { label: '🔑 Official API', hint: 'direct platform API using this bot’s configured credentials' },
  managed_service: { label: '🌐 Managed service', hint: 'an operator-selected gateway; no credentials needed here' },
  scraper: { label: '🔗 Scraper URL', hint: 'a credential-free HTTP(S) URL you provide' },
};

function watchTypeSelect() {
  const rows = Object.entries(WATCH_TYPE_META).map(([type, meta]) => [button(meta.label, `flow:watchtype:${type}`)]);
  rows.push([button('❌ Nah, cancel', 'flow:cancel:ask')]);
  return { text: "What's on your radar?", replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchMethodSelect(type) {
  const rows = Object.entries(WATCH_METHOD_META).map(([method, meta]) => [button(meta.label, `flow:watchmethod:${method}`)]);
  rows.push([button('❌ Nah, cancel', 'flow:cancel:ask')]);
  const typeLabel = WATCH_TYPE_META[type]?.label || type;
  return { text: `<b>${escapeTelegramHtml(typeLabel)}</b>\n\nHow's this rule pulling its intel?\n${Object.values(WATCH_METHOD_META).map(meta => `• <b>${meta.label}</b> — ${meta.hint}`).join('\n')}`, replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchConfigPrompt(field, hint) {
  return { text: `Drop the ${escapeTelegramHtml(field)}: ${escapeTelegramHtml(hint)}`, replyMarkup: keyboard([[button('❌ Nah, cancel', 'flow:cancel:ask')]]), parseMode: 'HTML' };
}

function watchRuleConfirmation({ name, type, method, config }) {
  const configLines = Object.entries(config || {})
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `${key}: ${escapeTelegramHtml(Array.isArray(value) ? value.join(', ') : String(value))}`)
    .join('\n');
  return {
    text: `<b>📡 Confirm watch rule</b>\nName: ${escapeTelegramHtml(name)}\nWatching: ${WATCH_TYPE_META[type]?.label || type}\nMethod: ${WATCH_METHOD_META[method]?.label || method}\n${configLines}\n\nStand up this rule?`,
    replyMarkup: keyboard([[button('✅ Create rule', 'flow:watchconfirm')], [button('❌ Nah, cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Real interactive list (replacing the old plain-text-only /watch list output as the menu
// button's target): tapping a rule opens its actions instead of requiring the user to already
// know its UUID.
function watchRulesList(rules) {
  if (!rules.length) {
    return { text: "No social watch rules yet. Nothing on the radar.", replyMarkup: keyboard([[button('➕ Add a watch rule', 'watch:add:start')], [button('⬅️ Back to base', 'menu:main')]]), parseMode: 'HTML' };
  }
  const rows = rules.map(rule => [button(`${rule.enabled ? '🟢' : '⚪'} ${rule.name}`, `watch:manage:${rule.id}`)]);
  rows.push([button('➕ Add a watch rule', 'watch:add:start')]);
  rows.push([button('⬅️ Back to base', 'menu:main')]);
  return { text: 'Your social watch rules:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchRuleActions(rule) {
  const rows = [];
  rows.push([button(rule.enabled ? '⏸ Disable' : '▶️ Re-enable', `watch:toggle:${rule.id}`)]);
  rows.push([button('🗑️ Remove', `watch:remove:ask:${rule.id}`)]);
  rows.push([button('⬅️ Back to the list', 'watch:list')]);
  const typeLabel = WATCH_TYPE_META[rule.type]?.label || rule.type;
  return {
    text: `<b>${escapeTelegramHtml(rule.name)}</b>\nStatus: ${rule.enabled ? '🟢 enabled' : '⚪ disabled'}\nWatching: ${typeLabel}\nMethod: ${WATCH_METHOD_META[rule.method]?.label || rule.method}\nID: <code>${rule.id}</code>`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function confirmRemoveWatchRule(rule) {
  return {
    text: `Yeet watch rule <b>${escapeTelegramHtml(rule.name)}</b>? This is permanent, no undo button.`,
    replyMarkup: keyboard([
      [button('✅ Yes, remove it', `watch:remove:do:${rule.id}`)],
      [button('❌ No, keep it', `watch:manage:${rule.id}`)],
    ]),
    parseMode: 'HTML',
  };
}

function confirmRemoveWallet(label) {
  return {
    text: `Remove wallet <b>${escapeTelegramHtml(label)}</b>? This is permanent, no undo button.`,
    replyMarkup: keyboard([
      [button('✅ Yes, remove it', `wallet:remove:do:${label}`)],
      [button('❌ No, keep it', 'menu:wallets')],
    ]),
    parseMode: 'HTML',
  };
}

module.exports = {
  button,
  keyboard,
  mainMenu,
  walletsMenu,
  settingsMenu,
  tasksMenu,
  taskActions,
  confirmCancelTask,
  placeholderMenu,
  chainPicker,
  walletPicker,
  walletMultiPicker,
  contractDetails,
  contractDetailsText,
  collectionInfoCard,
  mintConfirmation,
  gasTolerancePrompt,
  sendConfirmation,
  taskConfirmation,
  taskScheduled,
  exportKeyWarning,
  confirmRemoveWallet,
  watchTypeSelect,
  watchMethodSelect,
  watchConfigPrompt,
  watchRuleConfirmation,
  watchRulesList,
  watchRuleActions,
  confirmRemoveWatchRule,
  modeMenu,
  MODE_META,
  gasMenu,
  sniperMenu,
  activityMenu,
  adminOverviewMenu,
  formatGmtPlus1,
};
