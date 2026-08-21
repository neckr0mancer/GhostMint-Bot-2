// Pure menu-building functions for the Milestone 15a/15b Telegram redesign. Nothing here talks
// to a bot, a database, or the transaction engine — every function takes plain data in and
// returns a { text, replyMarkup, parseMode } payload, which keeps this module trivially
// unit-testable and keeps server.js (the composition root) responsible only for wiring, not UI
// layout. Every returned text uses Telegram's HTML parse mode (<b>/<code>, never legacy
// *asterisk*/`backtick` Markdown) since that's the only mode server.js's tg* senders use -- any
// free-text value a user typed (a wallet label, a task name) is escaped with escapeTelegramHtml
// before being interpolated next to a real tag so it can never break or inject into the markup.

const { escapeTelegramHtml } = require('../security/botSecurity');
const { LIMITS, MIN_BATCH_WALLETS } = require('../validation/domain');

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
// Shown on the main menu until the account is actually protected. Deliberately persistent rather
// than a one-off tip: an account with no password cannot use the gate at all, so it is not "not yet
// configured", it is open -- anyone who picks up this chat can move funds and, worse, generate a
// link code and sign in as the owner on the dashboard.
//
// Returns '' once the account is secure, so a protected owner never sees security nagging.
// A null/absent `security` means the caller has no reading -- typically a fallback keyboard on an
// error path. That must produce NO warning: telling someone their account is exposed because a
// lookup was skipped would send them to fix something that is not broken.
function securityBanner(security) {
  if (!security) return '';
  const { passwordSet = false, gateLevel = 'off' } = security;
  if (!passwordSet) {
    return '\n\n⚠️ <b>Your account is unprotected.</b> Anyone who opens this chat can move your funds'
      + ' or link your account to their own device. Tap <b>Secure my account</b> below — it takes a minute.';
  }
  if (gateLevel === 'off') {
    return '\n\n⚠️ <b>Bot security is off.</b> Your password is set, but this chat will not ask for it.'
      + ' Tap <b>Secure my account</b> below to switch it on.';
  }
  return '';
}

function securityNeedsAttention(security) {
  return securityBanner(security) !== '';
}

// The walkthrough. Names the exact page and section rather than saying "go to settings", because
// the whole point is that the owner completes it rather than postponing it.
function securitySetupCard({ passwordSet = false, gateLevel = 'off' } = {}) {
  const done = '✅';
  const todo = '▫️';
  const step1 = passwordSet ? done : todo;
  const step2 = passwordSet && gateLevel !== 'off' ? done : todo;
  const body = passwordSet && gateLevel !== 'off'
    ? '<b>You are protected.</b> Sensitive actions in this chat ask for your password.'
    : 'Two steps, both on the dashboard. It cannot be done from chat — a password typed here would'
      + ' stay in your message history, which is exactly what we are protecting you from.';
  return {
    text: `<b>🔐 Secure my account</b>\n\n${body}\n\n`
      + `${step1} <b>1. Set a security password</b>\n`
      + '   Dashboard → <b>Account</b> → <b>Login credentials</b> → <b>Security password</b> → Set\n\n'
      + `${step2} <b>2. Turn on the bot password gate</b>\n`
      + '   Dashboard → <b>Settings</b> → <b>Password gate</b> → <b>Sensitive</b> or <b>Strict</b>\n\n'
      + '<b>Sensitive</b> asks before anything that moves funds, exposes a key, or links your account.\n'
      + '<b>Strict</b> also asks before showing your wallets, balances and activity.\n\n'
      + 'Once on, this chat stays unlocked for 10 minutes after each password entry. Send /lock to end that early.',
    replyMarkup: keyboard([[button('⬅️ Back to base', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

function mainMenu({ isOwner = false, security = null } = {}) {
  const rows = [
    [button('👛 Wallets', 'menu:wallets'), button('⚡ Mint', 'menu:mint')],
    [button('💸 Send', 'menu:send')],
    [button('🗓️ Tasks', 'menu:tasks'), button('🎯 Snipers', 'menu:snipers')],
    [button('📡 Watch rules', 'menu:watch'), button('📊 Activity', 'menu:activity')],
    [button('⛽ Gas', 'menu:gas'), button('⚙️ Settings', 'menu:settings')],
    [button('🔗 Link Discord or dashboard', 'link:generate')],
  ];
  if (isOwner) rows.push([button('🛡️ Admin', 'menu:admin')]);
  // First row, not last: an unprotected account is the most important thing on this screen.
  if (securityNeedsAttention(security)) rows.unshift([button('🔐 Secure my account', 'menu:security')]);
  return {
    text: '<b>👻 GhostMint</b>\n\nYour GhostMint command center. Pick a move below, or run a command straight in if you already know the play.'
      + securityBanner(security),
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// Batch was previously reachable only by knowing /batch existed -- the Mint button went straight
// into a single-wallet flow. This is the fork, mirroring Discord's mintModeMenu: the guided flow
// underneath is the same one, started with multi true or false.
function mintModeMenu() {
  return {
    text: '<b>🎯 Mint</b>\n\nOne wallet, or the whole squad?',
    replyMarkup: keyboard([
      [button('🎯 Single mint', 'menu:mint:single')],
      [button('🎯🎯 Batch mint (several wallets)', 'menu:mint:batch')],
      [button('⬅️ Back to base', 'menu:main')],
    ]),
    parseMode: 'HTML',
  };
}

// Telegram has no modal, so "add another key" is just another message -- the card below is the
// running tally, re-rendered after each one. The keys themselves are never echoed back: Telegram
// keeps chat history, and repeating what was just typed would put every key back on screen.
function batchImportMenu({ count = 0, chainLabel = '', dropped = 0 } = {}) {
  const ready = count > 0;
  const rows = [];
  if (ready) rows.push([button(`✅ Import ${count} wallet${count === 1 ? '' : 's'}`, 'wallet:batch-import:confirm')]);
  rows.push([button('❌ Nah, cancel', 'flow:cancel:ask')]);
  return {
    text: `<b>📥📥 Batch import${chainLabel ? ` · ${escapeTelegramHtml(chainLabel)}` : ''}</b>\n\n`
      + (ready
        ? `<b>${count}</b> key${count === 1 ? '' : 's'} ready. Send another message to add more, or import what you have.

Each wallet's chain is detected from its own balances — a batch can span chains.`
        : `Send your private keys now. Several can go in one message — on separate lines, or separated by commas — and you can send more messages to keep adding.

<b>Example (one message):</b>
<code>0xabc…1111,0xdef…2222</code>`)
      + (dropped ? `\n\n⚠️ ${dropped} key${dropped === 1 ? ' was' : 's were'} ignored — ${LIMITS.batchWalletImport} is the most one import can take. Import these, then start another batch.` : '')
      + "\n\n⚠️ <b>Not recommended:</b> keys pass through Telegram's message transit and may remain in chat history or notification previews. Delete your messages afterward if you can.",
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// Shown in place of a gated action while the conversation is locked. The copy states outright that
// a chat is a worse place for a password than the dashboard is -- the gate reduces the risk of a
// borrowed phone, it does not make typing secrets into Telegram safe, and pretending otherwise
// would be the more dangerous message.
const GATE_ACTION_LABELS = {
  mint: 'mint', schedule: 'schedule a mint', exportkey: 'export a private key', removewallet: 'remove a wallet', send: 'send funds',
  batchimport: 'import wallets', importwallet: 'import a wallet',
  walletlist: 'list your wallets', balance: 'check a balance', activity: 'see your activity',
};

function gateUnlockPrompt({ action }) {
  const what = GATE_ACTION_LABELS[action] || 'do that';
  const mintHint = action === 'mint'
    ? '\n\n⚡ <b>Minting feels slow with this on?</b> You can switch the password off for minting only,'
      + ' on the dashboard: <b>Settings</b> → <b>Password gate</b> → <b>Ask before minting</b>.'
      + ' Everything else stays protected. The risk: anyone who reaches this chat could then spend'
      + ' from your wallets on a contract of their choosing, without knowing your password.'
    : '';
  return {
    text: `<b>🔒 Locked</b>\n\nSend your account password to ${escapeTelegramHtml(what)}.`
      + '\n\nThis is the same password the dashboard uses. It stays unlocked here for 10 minutes.'
      + "\n\n⚠️ Your message crosses Telegram's servers — it is deleted the moment it arrives, but the"
      + ' dashboard is still the safer place for anything sensitive.'
      + mintHint,
    replyMarkup: keyboard([[button('❌ Nah, cancel', 'flow:cancel:ask')]]),
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
      [button('📥📥 Batch import', 'wallet:batch-import:start')],
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
  return { text: '<b>⚙️ Settings</b>\n\nSet GhostMint up your way.', replyMarkup: keyboard(rows), parseMode: 'HTML' };
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

// Used only for wallet create/import -- a private key or seed phrase is chain-agnostic within EVM
// (the same secret works identically on ethereum/base/arbitrum/polygon/robinhood; see
// botCommandService.js's own note that a wallet's stored chain is just a nominal home chain, not a
// functional gate), so five near-identical buttons for one real choice was noise, not a real
// decision. Matches the dashboard's own DEFAULT_EVM_CHAIN precedent (App.jsx) of just picking
// 'ethereum' rather than asking. Solana is shown, not hidden, so the picker's shape doesn't have to
// change again the day real Solana support lands -- tapping it today explains why it can't proceed
// yet instead of silently doing nothing.
function chainPicker(supportedChains, chains, { prefix = 'flow:chain', note } = {}) {
  const rows = [
    [button('⛓️ EVM', `${prefix}:ethereum`)],
    [button('◎ Solana (coming soon)', `${prefix}:solana-soon`)],
    [button('❌ Cancel', 'flow:cancel:ask')],
  ];
  return { text: `${note ? `${note}\n\n` : ''}Pick a network:`, replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function walletPicker(wallets, { prefix, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const rows = wallets.map(wallet => [button(`${wallet.label} (${wallet.chain})`, `${prefix}:${wallet.label}`)]);
  rows.push([button('⬅️ Back to wallets', 'menu:wallets')]);
  return { text: 'Which wallet are we using for this one?', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// Multi-select variant for /batch: tapping a wallet toggles it (re-renders this same menu with the
// updated checkmark), Continue only appears once at least one wallet is selected.
function walletMultiPicker(wallets, selectedLabels, { emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  if (wallets.length < MIN_BATCH_WALLETS) {
    return {
      text: `<b>Batch mint needs ${MIN_BATCH_WALLETS} wallets</b>

You have ${wallets.length}. A batch of one is just a single mint — use that instead, or add another wallet first.`,
      replyMarkup: keyboard([
        [button('🎯 Single mint instead', 'menu:mint:single')],
        [button('➕ Create wallet', 'wallet:create:start')],
        [button('⬅️ Back to base', 'menu:main')],
      ]),
      parseMode: 'HTML',
    };
  }
  const rows = wallets.map(wallet => {
    const checked = selectedLabels.includes(wallet.label);
    return [button(`${checked ? '✅' : '⬜'} ${wallet.label} (${wallet.chain})`, `flow:wallettoggle:${wallet.label}`)];
  });
  if (selectedLabels.length >= MIN_BATCH_WALLETS) {
    rows.push([button(`▶️ Wallets locked. Continue with ${selectedLabels.length}.`, 'flow:walletcontinue')]);
  }
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'Tap every wallet you want in this batch, then hit Continue:', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function sendConfirmation({ walletLabel, toAddress, chainLabel, amountETH, sym, estimatedGasETH, totalETH }) {
  return {
    text: `<b>🚀 Confirm send</b>\nFrom: ${escapeTelegramHtml(walletLabel)}\nTo: <code>${toAddress}</code>\nChain: ${chainLabel}\nAmount: ${amountETH} ${sym}\nEstimated gas: ~${estimatedGasETH} ${sym}\nTotal: ~${totalETH} ${sym}\n\nReady to send it?`,
    replyMarkup: keyboard([[button('✅ Send it', 'flow:sendconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
    replyMarkup: keyboard([[button('⚠️ I understand, export it', 'flow:exportconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
    collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>📜 Collection Details</b>',
    `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];
  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out. Floor: ${displayPrice.eth} ETH${usdSuffix(displayPrice.usd)}`
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
  // Sold out means there is nothing left to schedule a mint against -- Continue would only lead
  // into a task that could never fire successfully, so it drops the same way Mint Now does on
  // collectionInfoCard, leaving Cancel as the only way forward.
  const rows = data.soldOut ? [] : [[button('▶️ Continue', 'flow:mintdetailscontinue')]];
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return {
    text: contractDetailsText(data),
    replyMarkup: keyboard(rows),
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
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatGmtPlus1(value) {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() + 60 * 60 * 1000);
  const month = SHORT_MONTHS[shifted.getUTCMonth()];
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hh}:${mm} GMT+1`;
}

// Section AD Tier 1: the collection info card mint_guided's first screen renders instead of the
// old merged-details-header (Section M) -- market cap, live floor, and volume alongside the
// existing mint-specific fields, with "🪙 Mint Now" as one of several actions (Refresh,
// View on OpenSea) rather than the screen's only purpose. No dedicated Copy CA button -- the
// contract address is already <code>-wrapped a few lines up, tap-to-copy without one. stats is null until
// detectMintContract has been called with includeStats:true (server.js's job, not this file's);
// every stats-derived line is simply omitted rather than shown as a placeholder when a field is
// unavailable, the same "unknown is fine" convention contractDetailsText above already uses.
// openSeaUrl is built by the caller (server.js, from OPENSEA_CHAIN_SLUGS) rather than here, so
// this module stays free of a cross-directory import into src/mint/ -- null omits the button
// entirely rather than linking to a chain OpenSea doesn't index.
// Section AF -- humanizes an OpenSea stage_type ("public_sale", "presale", ...) into a fallback
// label for a stage OpenSea didn't give its own human-written label.
function humanizeStageType(stageType) {
  if (!stageType) return 'Phase';
  return stageType.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function stageSummaryLine(stage, sym) {
  const label = stage.label || humanizeStageType(stage.stageType);
  const price = stage.priceETH !== null && stage.priceETH !== undefined ? `${stage.priceETH} ${sym}` : 'price TBD';
  const cap = stage.maxPerWallet !== null && stage.maxPerWallet !== undefined ? ` · max ${stage.maxPerWallet}/wallet` : '';
  return `${escapeTelegramHtml(label)} — ${price}${cap}`;
}

// Classifies a stage against the current time -- the only source of truth for "what's live/upcoming"
// once a drop has more than the two OpenSea happens to name (activeStage/nextStage are just its own
// convenience pointers into this same list). Mirrors mintFlowDecision.schedulableStages' own
// "startTime in the future" definition of upcoming, without importing it (see the no-cross-import
// note above collectionInfoCard).
function classifyStage(stage, now) {
  if (stage.endTime && stage.endTime * 1000 <= now) return 'ended';
  if (stage.startTime && stage.startTime * 1000 > now) return 'upcoming';
  return 'live';
}

const PHASE_STATUS_EMOJI = { ended: '⚫', live: '🟢', upcoming: '🔵' };
const MAX_PHASE_LINES = 10;

// One compact line per stage, capped so a drop with an unusually long stage list can't blow up the
// card -- the phase picker (openSeaPhasePicker) shows every schedulable stage regardless, up to a
// generous cap of its own, so nothing schedulable is actually hidden here, only summarized.
function phaseLines(stages, sym, now) {
  const lines = stages.slice(0, MAX_PHASE_LINES).map(stage => {
    const status = classifyStage(stage, now);
    const label = escapeTelegramHtml(stage.label || humanizeStageType(stage.stageType));
    if (status === 'ended') {
      const price = stage.priceETH !== null && stage.priceETH !== undefined ? (Number(stage.priceETH) === 0 ? 'Free' : `${stage.priceETH} ${sym}`) : 'price unknown';
      return `${PHASE_STATUS_EMOJI.ended} ${label} — ${price} (ended)`;
    }
    const price = stage.priceETH !== null && stage.priceETH !== undefined ? (Number(stage.priceETH) === 0 ? 'Free' : `${stage.priceETH} ${sym}`) : 'price TBD';
    const time = status === 'live'
      ? (stage.endTime ? ` · ends ${formatGmtPlus1(stage.endTime * 1000)}` : '')
      : ` · opens ${formatGmtPlus1(stage.startTime * 1000)}`;
    return `${PHASE_STATUS_EMOJI[status]} ${label} — ${price}${time}`;
  });
  if (stages.length > MAX_PHASE_LINES) lines.push(`+${stages.length - MAX_PHASE_LINES} more — pick a phase to schedule to see the rest`);
  return lines;
}

function collectionInfoCard({ contractAddress, chainLabel, chainSym, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice, stats, drop, openSeaUrl }) {
  const sym = chainSym || 'ETH';
  // Blank lines below group the card into identity / price / stats / limits / description bands --
  // Telegram has no layout primitives beyond line breaks, so spacing IS the only alignment tool
  // available here.
  const lines = [
    collection?.name ? `<b>${escapeTelegramHtml(collection.name)}</b>` : '<b>📜 Collection Details</b>',
    `<code>${contractAddress}</code>`,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];

  if (soldOut) {
    lines.push(displayPrice
      ? `Status: Sold out. Floor: ${displayPrice.eth} ${sym}${usdSuffix(displayPrice.usd)}`
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

  // Section AF -- "can't you read the phases from OpenSea and the contract?" On-chain SeaDrop only
  // ever exposes the ONE currently-configured PublicDrop struct (the Opens/Opened line below), so it
  // can never say what's coming after that. drop is null unless OpenSea actually tracks this
  // contract as a drop -- omitted entirely rather than shown as a broken/empty section. Once sold
  // out there is nothing left for a phase to gate access to, so the section is dropped even if OpenSea
  // still hands back stale stage data for it.
  if (!soldOut && drop?.stages?.length) {
    lines.push('', `🎟️ <b>Phases (${drop.stages.length})</b>`, ...phaseLines(drop.stages, sym, Date.now()));
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

  // Sold out means there is nothing left to mint or schedule against -- only the info-only utility/
  // cancel row below remains. Mint via OpenSea and Schedule for OpenSea phase are NOT mutually
  // exclusive -- a stage can be live right now while a later one is separately upcoming, and both
  // actions are genuinely useful at once; the generic on-chain "Schedule for opening" fallback (no
  // eligibility proof this app can construct itself) is the only one gated on OpenSea having
  // nothing to say at all, same reasoning as Discord's own row-budget-driven version of this.
  const schedulable = (drop?.stages || []).filter(stage => stage.startTime && stage.startTime * 1000 > Date.now());
  const rows = [];
  if (!soldOut) {
    rows.push([button('🔥 Ape In', 'flow:mintdetailscontinue')]);
    // Section AF -- an allowlist/GTD/FCFS stage has no on-chain proof this app can construct itself;
    // OpenSea's own backend resolves eligibility, so this is the path that actually works for those.
    // Shown only when OpenSea confirms a stage is live right now -- there is nothing for it to mint
    // against otherwise.
    if (drop?.activeStage) rows.push([button('🎫 Mint via OpenSea', 'flow:mintviaopensea')]);
    if (schedulable.length > 0) {
      // A phase that hasn't opened yet has nothing to mint against -- being tapped-in and ready at
      // the exact open is what cuts the time wasted, not a pre-check OpenSea has no way to answer
      // ahead of time (see mintViaOpenSea's own notes). The count only shows once there's an actual
      // choice to make (see afterScheduleViaOpenSeaTap) -- a single upcoming stage schedules itself.
      const label = schedulable.length > 1 ? `🎫📅 Schedule OpenSea phase (${schedulable.length})` : '🎫📅 Schedule for OpenSea phase';
      rows.push([button(label, 'flow:scheduleviaopensea')]);
    } else if (opensInFuture) {
      rows.push([button('📅 Schedule for opening', `flow:schedulesuggest:${contractAddress}`)]);
    }
  }
  rows.push(utilityRow, [button('❌ Cancel', 'flow:cancel:ask')]);

  return {
    text: lines.join('\n'),
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

// Section AF -- shown only when there's a genuine choice (see mintFlowDecision.afterScheduleViaOpenSeaTap);
// a single upcoming stage schedules itself with no picker at all. One button per stage -- Telegram
// has no hard row cap the way Discord does, but a soft cap still applies so an unusually long stage
// list doesn't turn into a wall of buttons; callback_data carries the stage's index into
// drop.stages (not its OpenSea uuid -- a 36-char uuid plus this prefix would blow past Telegram's
// 64-byte callback_data limit, same reasoning Section AF's own flow:phase:<n>:<address> already
// relies on).
function openSeaPhasePicker(stages) {
  const shown = stages.slice(0, MAX_PHASE_LINES);
  const rows = shown.map(stage => [button(
    `🎫📅 ${stage.label || humanizeStageType(stage.stageType)} — opens ${formatGmtPlus1(stage.startTime * 1000)}`,
    `flow:scheduleviaopenseaphase:${stage.index}`,
  )]);
  const text = stages.length > MAX_PHASE_LINES
    ? `Which phase should this be scheduled against? Showing the first ${MAX_PHASE_LINES} of ${stages.length}.`
    : 'Which phase should this be scheduled against?';
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text, replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// phaseNumber > 1 means this task is a later stage of a multi-stage drop (Section AF). Its price and
// time were typed by hand off the project's own announcement -- nothing on-chain describes a stage
// that isn't live yet -- so the price line must not claim the contract said so.
function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, quantity, mintTime, autoDetectedTime, priceETH, priceUnknown, displayPrice, phaseNumber, viaOpenSea }) {
  const phase = Number(phaseNumber) > 1 ? Number(phaseNumber) : null;
  let priceLine;
  // Section AF -- OpenSea's own response at execution time determines the real price for an
  // allowlist/GTD/FCFS stage; nothing scheduled up front could ever be the real number.
  if (viaOpenSea) priceLine = 'Price: determined by OpenSea at mint time (it resolves eligibility and price for this stage automatically)';
  else if (phase) priceLine = `Price: ${priceETH} per item (your number for this phase)`;
  else if (priceUnknown) priceLine = 'Price: not exposed by this contract. Using the amount you entered above.';
  else priceLine = `Price: ${priceETH} per item (pulled straight from the contract)${displayPrice ? usdSuffix(displayPrice.usd) : ''}`;
  const timeLine = autoDetectedTime
    ? `Fires: <b>${formatGmtPlus1(mintTime)}</b> (this contract's own opening time)`
    : `Fires: <b>${formatGmtPlus1(mintTime)}</b>`;
  const heading = viaOpenSea ? '<b>⏰🎫 Confirm OpenSea-backed schedule</b>' : phase ? `<b>⏰ Confirm phase ${phase}</b>` : '<b>⏰ Confirm scheduled mint</b>';
  return {
    text: `${heading}\nName: ${escapeTelegramHtml(name)}\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet: ${escapeTelegramHtml(walletLabel)}\nQuantity: ${quantity || 1}\n${priceLine}\n${timeLine}\n\nThis is not a reminder — the bot signs and sends the mint itself at that moment, phone in your pocket, you asleep.\n\nLock it in?`,
    replyMarkup: keyboard([[button('✅ Schedule it', 'flow:taskconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
    parseMode: 'HTML',
  };
}

// Success screen for a created task, and the whole point of Section AF: a drop with several stages
// has no on-chain schedule to read (SeaDrop's PublicDrop is one mutable struct describing only the
// stage that is live right now), so the only way to pre-arm every stage is one task per stage, each
// with its own hand-entered time and price. Offering that as the obvious next tap is the feature --
// the contract address rides in the callback data so the next phase skips straight past re-pasting.
function taskScheduled({ name, contractAddress, mintTime, phaseNumber, viaOpenSea }) {
  const phase = Number(phaseNumber) > 1 ? Number(phaseNumber) : 1;
  const armed = viaOpenSea
    ? `✅🎫 Armed via OpenSea: <b>${escapeTelegramHtml(name)}</b>`
    : phase > 1
      ? `✅ Phase ${phase} armed: <b>${escapeTelegramHtml(name)}</b>`
      : `✅ Locked in: <b>${escapeTelegramHtml(name)}</b>`;
  // Section AF -- "Add phase" is the manual-entry path (its own hand-typed price/time, no on-chain
  // or OpenSea data behind it) and still can't cover an allowlist/GTD stage that way; the OpenSea
  // button on the collection card is the actual answer for those now, so this points there instead
  // of just saying they can't be scheduled at all, which stopped being true once that button shipped.
  const nextStageHint = viaOpenSea
    ? "Got another OpenSea phase coming up? Head back to that contract's card and tap Schedule for OpenSea phase again once the next one shows."
    : 'Got another public stage? Stack another task for it: different time, different price, and the bot works down the list. An allowlist/GTD stage still can\'t go through Add phase (it has no price/time for you to type by hand) -- if OpenSea tracks the drop, use "Schedule for OpenSea phase" on its collection card instead.';
  const rows = viaOpenSea ? [] : [[button(`➕ Add phase ${phase + 1}`, `flow:phase:${phase + 1}:${contractAddress}`)]];
  rows.push([button('🗓️ See all tasks', 'menu:tasks')], [button('⬅️ Back to base', 'menu:main')]);
  return {
    text: `${armed}\nFires: <b>${formatGmtPlus1(mintTime)}</b>\n\n${nextStageHint}`,
    replyMarkup: keyboard(rows),
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
    : "Couldn't fetch gas right now. Network's ghosting us.";
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
    const row = [button(`${task.viaOpenSea ? '🎫' : '⏱'} ${shortName} [${task.status}]`, `task:manage:${task.id}`)];
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
  // A viaOpenSea task's price is always stored as 0 -- OpenSea's own response at execution time
  // determines the real value, never anything scheduled up front -- so "Free" would be a real lie
  // for a paid allowlist/GTD stage, not just an unhelpful label.
  const priceLine = task.viaOpenSea ? 'via OpenSea (determined at mint time)' : (task.price > 0 ? `${task.price} ETH` : 'Free');
  return {
    text: `<b>${escapeTelegramHtml(task.name)}</b>${task.viaOpenSea ? ' 🎫' : ''} [${task.status}]\nContract: <code>${task.contract}</code>\nWallet: ${escapeTelegramHtml(task.walletLabel)}\nQty: ${task.qty} | Price: ${priceLine}\nDue: <b>${formatGmtPlus1(task.mintTime)}</b>\nID: <code>${task.id}</code>`,
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
      replyMarkup: keyboard([[button('➕ Create sniper', 'sniper:create:start')], [button('⬅️ Back to base', 'menu:main')]]),
      parseMode: 'HTML',
    };
  }
  // The full address, never truncated -- a shortened display would still be <code>-wrapped and look
  // tap-to-copy, but copying it hands back a truncated string that isn't a usable address at all.
  const list = snipers.map(s =>
    `${s.active ? '🟢' : '⚪'} <b>${escapeTelegramHtml(s.label)}</b>\nTarget: <code>${s.targetAddress}</code>\nChain: ${s.chain} · Wallet: ${escapeTelegramHtml(s.walletLabel)}\nHits: ${s.hits || 0} · Fails: ${s.fails || 0}`,
  ).join('\n\n');
  return {
    text: `<b>🎯 Post-confirmation copy snipers (${snipers.length})</b>\n<i>Not mempool front-running: copying begins only after the source transaction confirms.</i>\n\n${list}`,
    replyMarkup: keyboard([[button('➕ Create sniper', 'sniper:create:start')], [button('⬅️ Back to base', 'menu:main')]]),
    parseMode: 'HTML',
  };
}

// Section O -- performs the same lookup /activity already does, with Prev/Next paging (no Prev on
// page 1, no Next once the last page is reached) instead of requiring the page number be typed.
function activityMenu(page) {
  const lines = page.items.length
    ? page.items.map(a => {
        const icon = a.status === 'success' ? '✅' : '❌';
        // a.address is a separate column from a.title specifically so it can be wrapped in a real
        // <code> tag here -- title goes through escapeTelegramHtml, and an address baked into that
        // same string would have its own tap-to-copy markup escaped right along with it.
        const addressLine = a.address ? ` to <code>${a.address}</code>` : '';
        const tx = a.txHash ? `\n   <a href="${a.explorer}${a.txHash}">View tx</a>` : '';
        return `${icon} ${escapeTelegramHtml(a.title)}${addressLine} · <b>${escapeTelegramHtml(a.walletLabel)}</b>\n   ${new Date(a.time).toLocaleString()}${tx}`;
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
  ultra_fast: { label: 'Degen', hint: 'Full send. Aggressive gas, minimal friction.' },
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
    text: `<b>🎛️ Transaction mode</b>\n\nCurrent mode: <b>${escapeTelegramHtml(currentLabel)}</b>\n\nControls confirmation prompts and how hard this thing sends gas on every mint. Ceilings and forced simulation always have the final say, no matter which mode you pick.${lockedNote}`,
    replyMarkup: keyboard(rows),
    parseMode: 'HTML',
  };
}

function mintConfirmation({ contractAddress, chainLabel, walletLabels, quantity = 1, priceETH, priceUnknown, maxGasGwei }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract. Using the amount you entered above.'
    : `Price: ${priceETH} per item (pulled straight from the contract)`;
  // maxGasGwei only ever appears here for a batch (see afterGasToleranceResolved) -- undefined
  // means this confirm screen isn't reachable through that step at all (a plain /mint), so the
  // line is omitted entirely rather than shown as "not set" for a flow that was never asked.
  const gasLine = maxGasGwei === undefined ? '' : `\nGas tolerance: ${maxGasGwei === null ? 'no extra limit (account ceiling only)' : `up to ${maxGasGwei} gwei`}`;
  return {
    text: `<b>🪙 Confirm mint</b>\nContract: <code>${contractAddress}</code>\nChain: ${chainLabel}\nWallet(s): ${walletLabels.map(escapeTelegramHtml).join(', ')}\nQuantity: ${quantity} each\n${priceLine}${gasLine}\n\nLocked in?`,
    replyMarkup: keyboard([[button('✅ Send it', 'flow:mintconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
      [button('❌ Cancel', 'flow:cancel:ask')],
    ]),
    parseMode: 'HTML',
  };
}

// Guided sniper-creation flow (mirrors src/sniper/sniperFlowDecision.js's step ordering). Only the
// genuinely structured steps live here -- awaiting_label/awaiting_target and the tolerance
// customize sub-fields are plain free-text prompts, inlined directly in server.js's renderFlowStep
// the same way watch_guided's own awaiting_name step already is.

// A real per-chain choice, unlike wallet create/import's EVM/Solana-collapsed chainPicker above --
// the sniper's chain determines which chain's watcher/RPC pool ends up watching the target wallet,
// so it has to be a specific chain, not an EVM-wide default. Mirrors gasMenu's own per-chain button
// grid (chunk(items, 3)) rather than reusing chainPicker.
function sniperChainSelect(supportedChains, chains) {
  const chainButtons = supportedChains.map(value => button(chainButtonLabel(value, chains), `flow:sniperchain:${value}`));
  const rows = chunk(chainButtons, 3);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: 'Which chain does that wallet operate on?', replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

// Every field here already has a working default in validateSniper -- accepting them is one tap;
// customizing walks the three fields one at a time (awaiting_tolerance_gas/_value/_cap in
// server.js), the same free-text-with-a-default-hint shape watch_guided's awaiting_config uses.
function sniperTolerancePrompt({ maxGasGwei, maxValueETH, dailySpendingCapETH }) {
  return {
    text: `<b>⛽ Fee tolerance & caps</b>\nDefaults: max gas <b>${maxGasGwei} gwei</b> · max value per fire <b>${maxValueETH} ETH</b> · daily spend cap <b>${dailySpendingCapETH} ETH</b>.\n\nUse these, or set your own?`,
    replyMarkup: keyboard([
      [button('✅ Use these defaults', 'flow:snipertoleranceaccept')],
      [button('✏️ Set my own', 'flow:snipertolerancemanual')],
      [button('❌ Cancel', 'flow:cancel:ask')],
    ]),
    parseMode: 'HTML',
  };
}

function sniperConfirmation(data) {
  const fmt = (value, fallback) => (value === undefined || value === null ? `default (${fallback})` : value);
  return {
    text: `<b>🎯 Confirm sniper</b>\nLabel: <b>${escapeTelegramHtml(data.label)}</b>\nTarget: <code>${data.targetAddress}</code>\nChain: ${data.chain}\nWallet: ${escapeTelegramHtml(data.walletLabel)}\nMax gas: ${fmt(data.maxGasGwei, '200 gwei')}\nMax value/fire: ${fmt(data.maxValueETH, '0.1 ETH')}\nDaily cap: ${fmt(data.dailySpendingCapETH, '0.25 ETH')}\n\nCreate this sniper?`,
    replyMarkup: keyboard([
      [button('✅ Create', 'flow:sniperconfirm')],
      [button('❌ Cancel', 'flow:cancel:ask')],
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
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  return { text: "What's on your radar?", replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchMethodSelect(type) {
  const rows = Object.entries(WATCH_METHOD_META).map(([method, meta]) => [button(meta.label, `flow:watchmethod:${method}`)]);
  rows.push([button('❌ Cancel', 'flow:cancel:ask')]);
  const typeLabel = WATCH_TYPE_META[type]?.label || type;
  return { text: `<b>${escapeTelegramHtml(typeLabel)}</b>\n\nHow's this rule pulling its intel?\n${Object.values(WATCH_METHOD_META).map(meta => `• <b>${meta.label}</b> — ${meta.hint}`).join('\n')}`, replyMarkup: keyboard(rows), parseMode: 'HTML' };
}

function watchConfigPrompt(field, hint) {
  return { text: `Drop the ${escapeTelegramHtml(field)}: ${escapeTelegramHtml(hint)}`, replyMarkup: keyboard([[button('❌ Cancel', 'flow:cancel:ask')]]), parseMode: 'HTML' };
}

function watchRuleConfirmation({ name, type, method, config }) {
  const configLines = Object.entries(config || {})
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `${key}: ${escapeTelegramHtml(Array.isArray(value) ? value.join(', ') : String(value))}`)
    .join('\n');
  return {
    text: `<b>📡 Confirm watch rule</b>\nName: ${escapeTelegramHtml(name)}\nWatching: ${WATCH_TYPE_META[type]?.label || type}\nMethod: ${WATCH_METHOD_META[method]?.label || method}\n${configLines}\n\nStand up this rule?`,
    replyMarkup: keyboard([[button('✅ Create rule', 'flow:watchconfirm')], [button('❌ Cancel', 'flow:cancel:ask')]]),
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
  mintModeMenu,
  batchImportMenu,
  securityBanner,
  securityNeedsAttention,
  securitySetupCard,
  gateUnlockPrompt,
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
  openSeaPhasePicker,
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
  sniperChainSelect,
  sniperTolerancePrompt,
  sniperConfirmation,
  activityMenu,
  adminOverviewMenu,
  formatGmtPlus1,
};
