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
  placeholderMenu,
  chainPicker,
  walletPicker,
  walletMultiPicker,
  mintConfirmation,
  sendConfirmation,
  exportKeyWarning,
  confirmCancelPrompt,
  confirmRemoveWallet,
};
