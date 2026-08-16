// Pure menu-building functions for the Milestone 15a/15b Telegram redesign. Nothing here talks
// to a bot, a database, or the transaction engine — every function takes plain data in and
// returns a { text, replyMarkup } payload, which keeps this module trivially unit-testable and
// keeps server.js (the composition root) responsible only for wiring, not UI layout.

function button(text, callbackData) {
  return { text, callback_data: callbackData };
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
    text: '*GhostMint*\n\nChoose a section below, or type a command directly if you already know it.',
    replyMarkup: keyboard(rows),
  };
}

function walletsMenu() {
  return {
    text: '*Wallets*\n\nGenerating a new wallet server-side is recommended over importing an existing key.',
    replyMarkup: keyboard([
      [button('📋 List wallets', 'wallet:list')],
      [button('➕ Create wallet', 'wallet:create:start')],
      [button('📥 Import wallet', 'wallet:import:start')],
      [button('💰 Check balance', 'wallet:balance:pick')],
      [button('🔑 Export key', 'menu:exportkey')],
      [button('🗑️ Remove wallet', 'wallet:remove:pick')],
      [button('⬅️ Back to menu', 'menu:main')],
    ]),
  };
}

function settingsMenu({ isOwner = false } = {}) {
  const rows = [
    [button('🔗 Link another platform', 'link:generate')],
    [button('🎛️ Transaction mode', 'menu:mode')],
  ];
  if (isOwner) rows.push([button('🛡️ Admin console', 'menu:admin')]);
  rows.push([button('⬅️ Back to menu', 'menu:main')]);
  return { text: '*Settings*', replyMarkup: keyboard(rows) };
}

function placeholderMenu(title, hint) {
  return {
    text: `*${title}*\n\n${hint}`,
    replyMarkup: keyboard([[button('⬅️ Back to menu', 'menu:main')]]),
  };
}

function chainPicker(supportedChains, chains, { prefix = 'flow:chain' } = {}) {
  const rows = supportedChains.map(chain => [button(chains[chain]?.name || chain, `${prefix}:${chain}`)]);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'Choose a chain:', replyMarkup: keyboard(rows) };
}

function walletPicker(wallets, { prefix, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const rows = wallets.map(wallet => [button(`${wallet.label} (${wallet.chain})`, `${prefix}:${wallet.label}`)]);
  rows.push([button('⬅️ Back to menu', 'menu:wallets')]);
  return { text: 'Choose a wallet:', replyMarkup: keyboard(rows) };
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
  return { text: 'Tap each wallet to include in the batch, then Continue:', replyMarkup: keyboard(rows) };
}

function sendConfirmation({ walletLabel, toAddress, chainLabel, amountETH, sym, estimatedGasETH, totalETH }) {
  return {
    text: `*Confirm send*\nFrom: ${walletLabel}\nTo: \`${toAddress}\`\nChain: ${chainLabel}\nAmount: ${amountETH} ${sym}\nEstimated gas: ~${estimatedGasETH} ${sym}\nTotal: ~${totalETH} ${sym}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Confirm', 'flow:sendconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
  };
}

// Deliberately not a bare "Confirm" -- this is the one place in the app where under-promising is
// the correct product decision. The warning has to say the timer is a courtesy, not a control,
// because it is: the key still transits Telegram's servers and can be screenshotted or forwarded
// before it fires.
function exportKeyWarning({ walletLabel }) {
  return {
    text: `⚠️ *Export private key for ${walletLabel}?*\n\nThis reveals full control of this wallet's funds. The message will auto-delete shortly, but deletion is a courtesy, not a control — the key still transits Telegram's servers and can be screenshotted or forwarded before the timer fires. Only proceed if you understand the risk.`,
    replyMarkup: keyboard([[button('⚠️ Export anyway', 'flow:exportconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
function contractDetails({ contractAddress, chainLabel, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice }) {
  const lines = [collection?.name ? `*${collection.name}*` : '*Contract details*', `\`${contractAddress}\``,
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
  if (collection?.description) lines.push('', collection.description.slice(0, 300));
  return {
    text: lines.join('\n'),
    replyMarkup: keyboard([[button('▶️ Continue', 'flow:mintdetailscontinue')], [button('❌ Cancel', 'flow:cancel:ask')]]),
  };
}

function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, mintTime, autoDetectedTime, priceETH, priceUnknown, displayPrice }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)${displayPrice ? usdSuffix(displayPrice.usd) : ''}`;
  const timeLine = autoDetectedTime
    ? `Fires (UTC): *${mintTime}* (this contract's own opening time)`
    : `Fires (UTC): *${mintTime}*`;
  return {
    text: `*Confirm scheduled mint*\nName: ${name}\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet: ${walletLabel}\nQuantity: 1\n${priceLine}\n${timeLine}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Schedule it', 'flow:taskconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
  };
}

function tasksMenu() {
  return {
    text: '*Tasks*\n\nSchedule a mint to run automatically at a future time. Use /tasks to list, /canceltask, /pausetask, /resumetask, or /retrytask <id> to manage one.',
    replyMarkup: keyboard([
      [button('🗓️ Schedule mint', 'menu:schedule')],
      [button('⬅️ Back to menu', 'menu:main')],
    ]),
  };
}

function mintConfirmation({ contractAddress, chainLabel, walletLabels, priceETH, priceUnknown }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)`;
  return {
    text: `*Confirm mint*\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet(s): ${walletLabels.join(', ')}\nQuantity: 1 each\n${priceLine}\n\nProceed?`,
    replyMarkup: keyboard([[button('✅ Confirm', 'flow:mintconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
  };
}

function confirmCancelPrompt(flowLabel) {
  return {
    text: `You're in the middle of *${flowLabel}*. Leave it and go back to the menu? Your progress will be cleared.`,
    replyMarkup: keyboard([
      [button('✅ Yes, cancel and go back', 'flow:cancel:confirm')],
      [button('↩️ No, keep going', 'flow:cancel:resume')],
    ]),
  };
}

function confirmRemoveWallet(label) {
  return {
    text: `Remove wallet *${label}*? This cannot be undone.`,
    replyMarkup: keyboard([
      [button('✅ Yes, remove it', `wallet:remove:do:${label}`)],
      [button('❌ No, keep it', 'menu:wallets')],
    ]),
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
  mintConfirmation,
  sendConfirmation,
  taskConfirmation,
  exportKeyWarning,
  confirmCancelPrompt,
  confirmRemoveWallet,
};
