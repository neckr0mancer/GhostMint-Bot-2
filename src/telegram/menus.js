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
    text: '<b>GhostMint</b>\n\nChoose a section below, or type a command directly if you already know it.',
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function walletsMenu() {
  return {
    text: '<b>Wallets</b>\n\nGenerating a new wallet server-side is recommended over importing an existing key.',
    replyMarkup: keyboard([
      [button('📋 List wallets', 'wallet:list')],
      [button('➕ Create wallet', 'wallet:create:start')],
      [button('📥 Import wallet', 'wallet:import:start')],
      [button('💰 Check balance', 'wallet:balance:pick')],
      [button('🔑 Export key', 'menu:exportkey')],
      [button('🗑️ Remove wallet', 'wallet:remove:pick')],
      [button('⬅️ Back to menu', 'menu:main')],
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
  rows.push([button('⬅️ Back to menu', 'menu:main')]);
  return { text: '<b>Settings</b>', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// title/hint are always literal strings the developer wrote at the call site (never user input),
// and a couple of call sites already hand-escape a literal placeholder like "&lt;id&gt;" into
// hint themselves -- so neither is run through escapeTelegramHtml here, which would double-escape
// those entities.
function placeholderMenu(title, hint) {
  return {
    text: `<b>${title}</b>\n\n${hint}`,
    replyMarkup: keyboard([[button('⬅️ Back to menu', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

function chainPicker(supportedChains, chains, { prefix = 'flow:chain' } = {}) {
  const rows = supportedChains.map(chain => [button(chains[chain]?.name || chain, `${prefix}:${chain}`)]);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'Choose a chain:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function walletPicker(wallets, { prefix, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const rows = wallets.map(wallet => [button(`${wallet.label} (${wallet.chain})`, `${prefix}:${wallet.label}`)]);
  rows.push([button('⬅️ Back to menu', 'menu:wallets')]);
  return { text: 'Choose a wallet:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
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
    rows.push([button(`▶️ Continue with ${selectedLabels.length} wallet${selectedLabels.length === 1 ? '' : 's'}`, 'flow:walletcontinue')]);
  }
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'Tap each wallet to include in the batch, then Continue:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function sendConfirmation({ walletLabel, toAddress, chainLabel, amountETH, sym, estimatedGasETH, totalETH }) {
  return {
    text: `<b>Confirm send</b>\nFrom: ${escapeTelegramHtml(walletLabel)}\nTo: <code>${toAddress}</code>\nChain: ${chainLabel}\nAmount: ${amountETH} ${sym}\nEstimated gas: ~${estimatedGasETH} ${sym}\nTotal: ~${totalETH} ${sym}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Confirm', 'flow:sendconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Deliberately not a bare "Confirm" -- this is the one place in the app where under-promising is
// the correct product decision. The warning has to say the timer is a courtesy, not a control,
// because it is: the key still transits Telegram's servers and can be screenshotted or forwarded
// before it fires.
function exportKeyWarning({ walletLabel }) {
  return {
    text: `⚠️ <b>Export private key for ${escapeTelegramHtml(walletLabel)}?</b>\n\nThis reveals full control of this wallet's funds. The message will auto-delete shortly, but deletion is a courtesy, not a control — the key still transits Telegram's servers and can be screenshotted or forwarded before the timer fires. Only proceed if you understand the risk.`,
    replyMarkup: keyboard([[button('⚠️ Export anyway', 'flow:exportconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
  const lines = [collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>Contract details</b>', `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel}`, `Type: ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`];
  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out — floor price ${displayPrice.eth} ETH${usdSuffix(displayPrice.usd)}`
      : 'Status: Sold out — floor price unavailable');
  } else {
    lines.push(priceUnknown
      ? 'Price: not exposed by this contract — you will be asked to enter it'
      : `Price: ${priceETH} per item${displayPrice ? usdSuffix(displayPrice.usd) : ''}`);
  }
  if (maxPerWallet !== null && maxPerWallet !== undefined) lines.push(`Max per wallet: ${maxPerWallet}`);
  if (maxSupply !== null && maxSupply !== undefined) lines.push(`Max supply: ${maxSupply}`);
  if (startTime) {
    const opensAt = new Date(startTime * 1000).toISOString();
    lines.push(startTime * 1000 > Date.now() ? `Opens: ${opensAt} UTC` : `Opened: ${opensAt} UTC`);
  }
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
    replyMarkup: keyboard([[button('▶️ Continue', 'flow:mintdetailscontinue')], [button('❌ Cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Rounds to 4 decimal places for display -- enough precision to distinguish real mint/floor
// prices without spilling a raw wei-derived float's trailing digits onto the card.
function formatEthAmount(value, sym) {
  if (value === null || value === undefined) return null;
  return `${Math.round(value * 10_000) / 10_000} ${sym || 'ETH'}`;
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
  const lines = [
    collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>Contract details</b>',
    `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
  ];

  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out — floor ${displayPrice.eth} ${sym}${usdSuffix(displayPrice.usd)}`
      : 'Status: Sold out — floor price unavailable');
  } else {
    lines.push(priceUnknown ? 'Mint price: not exposed by this contract' : `Mint price: ${priceETH} ${sym} per item`);
  }

  if (stats) {
    const floor = formatEthAmount(stats.floorPrice, stats.floorPriceSymbol || sym);
    if (floor) lines.push(`Floor: ${floor}${stats.numOwners !== null ? ` · ${stats.numOwners} holders` : ''}`);
    const marketCap = formatEthAmount(stats.marketCap, sym);
    if (marketCap) {
      const mintedNote = maxSupply ? `${stats.totalMinted}/${maxSupply} minted`
        : stats.totalMinted !== null ? `${stats.totalMinted} minted` : '';
      lines.push(`Market cap: ${marketCap}${mintedNote ? ` (${mintedNote})` : ''}`);
    }
    const volume = stats.volume || {};
    const volumeParts = [];
    if (volume.oneDay !== null && volume.oneDay !== undefined) volumeParts.push(`24h ${formatEthAmount(volume.oneDay, sym)}`);
    if (volume.sevenDay !== null && volume.sevenDay !== undefined) volumeParts.push(`7d ${formatEthAmount(volume.sevenDay, sym)}`);
    if (volume.thirtyDay !== null && volume.thirtyDay !== undefined) volumeParts.push(`30d ${formatEthAmount(volume.thirtyDay, sym)}`);
    if (volumeParts.length) lines.push(`Volume: ${volumeParts.join(' · ')}`);
  }

  if (maxPerWallet !== null && maxPerWallet !== undefined) lines.push(`Max per wallet: ${maxPerWallet}`);
  if (maxSupply !== null && maxSupply !== undefined) lines.push(`Max supply: ${maxSupply}`);
  if (startTime) {
    const opensAt = new Date(startTime * 1000).toISOString();
    lines.push(startTime * 1000 > Date.now() ? `Opens: ${opensAt} UTC` : `Opened: ${opensAt} UTC`);
  }
  if (collection?.description) lines.push('', escapeTelegramHtml(collection.description.slice(0, 300)));

  const utilityRow = [button('🔄 Refresh', 'flow:detailsrefresh')];
  if (openSeaUrl) utilityRow.push(urlButton('🔗 OpenSea', openSeaUrl));

  return {
    text: lines.join('\n'),
    replyMarkup: keyboard([
      [button('🪙 Mint Now', 'flow:mintdetailscontinue')],
      utilityRow,
      [button('📋 Copy CA', 'flow:copyca')],
      [button('❌ Cancel', 'flow:cancel:ask')],
    ]),
    parseMode: 'HTML',
  };
}

function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, mintTime, autoDetectedTime, priceETH, priceUnknown, displayPrice }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)${displayPrice ? usdSuffix(displayPrice.usd) : ''}`;
  const timeLine = autoDetectedTime
    ? `Fires (UTC): <b>${escapeTelegramHtml(mintTime)}</b> (this contract's own opening time)`
    : `Fires (UTC): <b>${escapeTelegramHtml(mintTime)}</b>`;
  return {
    text: `<b>Confirm scheduled mint</b>\nName: ${escapeTelegramHtml(name)}\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet: ${escapeTelegramHtml(walletLabel)}\nQuantity: 1\n${priceLine}\n${timeLine}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Schedule it', 'flow:taskconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
  const chainButtons = supportedChains.map(value => button(chains[value]?.name || value, `gas:chain:${value}`));
  const rows = chunk(chainButtons, 3);
  rows.push([button('⬅️ Back to menu', 'menu:main')]);
  const readout = fees
    ? `Safe: <b>${fees.safeGasPriceGwei ?? 'unavailable'}</b> Gwei\nStandard: <b>${fees.gasPriceGwei ?? 'unavailable'}</b> Gwei\nFast: <b>${fees.maxFeePerGasGwei ?? 'unavailable'}</b> Gwei`
    : 'Could not fetch gas prices for this chain.';
  return {
    text: `⛽ <b>Live Gas — ${escapeTelegramHtml(chains[chain]?.name || chain)}</b>\n${readout}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function tasksMenu() {
  return {
    text: '<b>Tasks</b>\n\nSchedule a mint to run automatically at a future time. Use /tasks to list, /canceltask, /pausetask, /resumetask, or /retrytask &lt;id&gt; to manage one.',
    replyMarkup: keyboard([
      [button('🗓️ Schedule mint', 'menu:schedule')],
      [button('⬅️ Back to menu', 'menu:main')],
    ]),
    parseMode: 'HTML',
  };
}

// Same 4 presets/labels as Discord's /mode choices (discordBot.js) -- kept in sync by hand since
// the two platforms build their option lists in entirely different shapes (inline keyboard vs.
// slash-command choices).
const MODE_META = {
  ultra_fast: { label: 'Degen', hint: 'fastest, high gas, no confirmation' },
  fast: { label: 'Fast', hint: 'quick, higher gas, still confirms' },
  semi_safe: { label: 'Cautious', hint: 'careful, moderate gas' },
  safe: { label: 'Normie', hint: 'slowest, safest, network-price gas' },
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
      return [button(`${preset.key === currentKey ? '✅ ' : ''}${meta.label} — ${meta.hint}`, `mode:pick:${preset.key}`)];
    });
  rows.push([button('⬅️ Back to settings', 'menu:settings')]);
  const currentLabel = MODE_META[currentKey]?.label || 'none selected';
  const lockedNote = advancedModesAllowed ? '' : '\n\n🔒 Degen and Fast require group or admin access.';
  return {
    text: `<b>Transaction mode</b>\n\nCurrent: <b>${escapeTelegramHtml(currentLabel)}</b>\n\nControls confirmation prompts and gas aggression for every mint. Ceilings and forced simulation always take precedence regardless of mode.${lockedNote}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function mintConfirmation({ contractAddress, chainLabel, walletLabels, quantity = 1, priceETH, priceUnknown }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)`;
  return {
    text: `<b>Confirm mint</b>\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet(s): ${walletLabels.map(escapeTelegramHtml).join(', ')}\nQuantity: ${quantity} each\n${priceLine}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Confirm', 'flow:mintconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Watch-rule guided create flow (mirrors src/social/watchRuleFlowDecision.js's step ordering).
const WATCH_TYPE_META = {
  twitter_account: { label: '🐦 Twitter — Account', hint: 'watch everything one X/Twitter account posts' },
  twitter_keyword: { label: '🐦 Twitter — Keyword', hint: 'watch X/Twitter for matching keywords' },
  discord_channel: { label: '💬 Discord — Channel', hint: 'watch every message in one Discord channel' },
  discord_keyword: { label: '💬 Discord — Keyword', hint: 'watch Discord for matching keywords' },
  farcaster_account: { label: '🟣 Farcaster — Account', hint: 'watch everything one Farcaster account casts' },
  farcaster_keyword: { label: '🟣 Farcaster — Keyword', hint: 'watch Farcaster for matching keywords' },
};
const WATCH_METHOD_META = {
  official_api: { label: '🔑 Official API', hint: 'direct platform API using this bot’s configured credentials' },
  managed_service: { label: '🌐 Managed service', hint: 'an operator-selected gateway; no credentials needed here' },
  scraper: { label: '🔗 Scraper URL', hint: 'a credential-free HTTP(S) URL you provide' },
};

function watchTypeSelect() {
  const rows = Object.entries(WATCH_TYPE_META).map(([type, meta]) => [button(meta.label, `flow:watchtype:${type}`)]);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'What do you want to watch?', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchMethodSelect(type) {
  const rows = Object.entries(WATCH_METHOD_META).map(([method, meta]) => [button(meta.label, `flow:watchmethod:${method}`)]);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  const typeLabel = WATCH_TYPE_META[type]?.label || type;
  return { text: `<b>${escapeTelegramHtml(typeLabel)}</b>\n\nHow should this rule get its data?\n${Object.values(WATCH_METHOD_META).map(meta => `• <b>${meta.label}</b> — ${meta.hint}`).join('\n')}`, replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchConfigPrompt(field, hint) {
  return { text: `Send the ${escapeTelegramHtml(field)}: ${escapeTelegramHtml(hint)}`, replyMarkup: keyboard([[button('❌ Cancel', 'flow:cancel:ask')]]), parseMode: 'HTML' };
}

function watchRuleConfirmation({ name, type, method, config }) {
  const configLines = Object.entries(config || {})
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `${key}: ${escapeTelegramHtml(Array.isArray(value) ? value.join(', ') : String(value))}`)
    .join('\n');
  return {
    text: `<b>Confirm watch rule</b>\nName: ${escapeTelegramHtml(name)}\nWatching: ${WATCH_TYPE_META[type]?.label || type}\nMethod: ${WATCH_METHOD_META[method]?.label || method}\n${configLines}\n\nCreate this rule?`,
    replyMarkup: keyboard([[button('✅ Create rule', 'flow:watchconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Real interactive list (replacing the old plain-text-only /watch list output as the menu
// button's target): tapping a rule opens its actions instead of requiring the user to already
// know its UUID.
function watchRulesList(rules) {
  if (!rules.length) {
    return { text: 'No social watch rules yet.', replyMarkup: keyboard([[button('➕ Add a watch rule', 'watch:add:start')], [button('⬅️ Back to menu', 'menu:main')]]), parseMode: 'HTML' };
  }
  const rows = rules.map(rule => [button(`${rule.enabled ? '🟢' : '⚪'} ${rule.name}`, `watch:manage:${rule.id}`)]);
  rows.push([button('➕ Add a watch rule', 'watch:add:start')]);
  rows.push([button('⬅️ Back to menu', 'menu:main')]);
  return { text: 'Your social watch rules:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchRuleActions(rule) {
  const rows = [];
  rows.push([button(rule.enabled ? '⏸ Disable' : '▶️ Re-enable', `watch:toggle:${rule.id}`)]);
  rows.push([button('🗑️ Remove', `watch:remove:ask:${rule.id}`)]);
  rows.push([button('⬅️ Back to list', 'watch:list')]);
  const typeLabel = WATCH_TYPE_META[rule.type]?.label || rule.type;
  return {
    text: `<b>${escapeTelegramHtml(rule.name)}</b>\nStatus: ${rule.enabled ? '🟢 enabled' : '⚪ disabled'}\nWatching: ${typeLabel}\nMethod: ${WATCH_METHOD_META[rule.method]?.label || rule.method}\nID: <code>${rule.id}</code>`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function confirmRemoveWatchRule(rule) {
  return {
    text: `Remove watch rule <b>${escapeTelegramHtml(rule.name)}</b>? This cannot be undone.`,
    replyMarkup: keyboard([
      [button('✅ Yes, remove it', `watch:remove:do:${rule.id}`)],
      [button('❌ No, keep it', `watch:manage:${rule.id}`)],
    ]),
    parseMode: 'HTML',
  };
}

function confirmCancelPrompt(flowLabel) {
  return {
    text: `You're in the middle of <b>${escapeTelegramHtml(flowLabel)}</b>. Leave it and go back to the menu? Your progress will be cleared.`,
    replyMarkup: keyboard([
      [button('✅ Yes, cancel and go back', 'flow:cancel:confirm')],
      [button('↩️ No, keep going', 'flow:cancel:resume')],
    ]),
    parseMode: 'HTML',
  };
}

function confirmRemoveWallet(label) {
  return {
    text: `Remove wallet <b>${escapeTelegramHtml(label)}</b>? This cannot be undone.`,
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
  placeholderMenu,
  chainPicker,
  walletPicker,
  walletMultiPicker,
  contractDetails,
  contractDetailsText,
  collectionInfoCard,
  mintConfirmation,
  sendConfirmation,
  taskConfirmation,
  exportKeyWarning,
  confirmCancelPrompt,
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
};
