// Pure component-building functions for the Milestone 15c Discord redesign, mirroring
// src/telegram/menus.js: every function takes plain data in and returns a raw, Discord
// API-shaped payload ({ content, components } with numeric `type`s and `custom_id`s), not
// discord.js builder instances. discord.js accepts already-API-shaped objects for
// interaction.reply/update/showModal, so this stays fully unit-testable without loading
// discord.js, and discordBot.js (the composition root) is responsible only for wiring.

const { LIMITS, MIN_BATCH_WALLETS } = require('../validation/domain');

const ROW = 1;
const BUTTON = 2;
const SELECT = 3;
const TEXT_INPUT = 4;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const TEXT_STYLE = { short: 1, paragraph: 2 };

// disabled is the 5th parameter, after emoji, because emoji was here first and gas:chain:*
// passes it positionally. Discord rejects the whole component payload for an unknown emoji
// shape, so a disabled flag passed in the emoji slot is not a cosmetic mistake.
function button(label, customId, style = 'secondary', emoji, disabled = false) {
  const value = { type: BUTTON, style: BUTTON_STYLE[style] || BUTTON_STYLE.secondary, custom_id: customId, label };
  if (emoji) value.emoji = emoji;
  if (disabled) value.disabled = true;
  return value;
}

// A link-style button (style 5) opens directly in the user's browser and carries `url` instead of
// `custom_id` -- Discord never sends this bot an interaction for it at all, same distinction as
// Telegram's urlButton.
function urlButton(label, url) {
  return { type: BUTTON, style: 5, url, label };
}

function row(components) {
  return { type: ROW, components };
}

function select(customId, options, placeholder, { minValues, maxValues } = {}) {
  const component = { type: SELECT, custom_id: customId, placeholder, options };
  if (minValues !== undefined) component.min_values = minValues;
  if (maxValues !== undefined) component.max_values = maxValues;
  return row([component]);
}

// Counterpart to the Telegram banner -- see src/telegram/menus.js for the reasoning. Shown until
// the account is actually protected, and gone entirely once it is.
// A null/absent `security` means the caller has no reading -- typically a fallback keyboard on an
// error path. That must produce NO warning: telling someone their account is exposed because a
// lookup was skipped would send them to fix something that is not broken.
function securityBanner(security) {
  if (!security) return '';
  const { passwordSet = false, gateLevel = 'off' } = security;
  if (!passwordSet) {
    return '\n\n⚠️ **Your account is unprotected.** Anyone who opens this chat can move your funds'
      + ' or link your account to their own device. Tap **Secure my account** below.';
  }
  if (gateLevel === 'off') {
    return '\n\n⚠️ **Bot security is off.** Your password is set, but this chat will not ask for it.'
      + ' Tap **Secure my account** below to switch it on.';
  }
  return '';
}

function securityNeedsAttention(security) {
  return securityBanner(security) !== '';
}

function securitySetupCard({ passwordSet = false, gateLevel = 'off' } = {}) {
  const step1 = passwordSet ? '✅' : '▫️';
  const step2 = passwordSet && gateLevel !== 'off' ? '✅' : '▫️';
  const body = passwordSet && gateLevel !== 'off'
    ? '**You are protected.** Sensitive actions here ask for your password.'
    : 'Two steps, both on the dashboard. It cannot be done from chat -- a password typed here would'
      + ' stay in your message history, which is exactly what this protects you from.';
  return {
    content: `## 🔐 Secure my account\n${body}\n\n`
      + `${step1} **1. Set a security password**\n`
      + 'Dashboard → **Account** → **Login credentials** → **Security password** → Set\n\n'
      + `${step2} **2. Turn on the bot password gate**\n`
      + 'Dashboard → **Settings** → **Password gate** → **Sensitive** or **Strict**\n\n'
      + '**Sensitive** asks before anything that moves funds, exposes a key, or links your account.\n'
      + '**Strict** also asks before showing your wallets, balances and activity.\n\n'
      + 'Once on, this chat stays unlocked for 10 minutes after each password entry.',
    components: [row([button('⬅️ Back to menu', 'menu:main')])],
  };
}

function mainMenu({ isOwner = false, security = null } = {}) {
  const rows = [
    row([button('👛 Wallets', 'menu:wallets'), button('⚡ Mint', 'menu:mint')]),
    row([button('🗓️ Tasks', 'menu:tasks'), button('🎯 Snipers', 'menu:snipers')]),
    row([button('📡 Watch rules', 'menu:watch'), button('📊 Activity', 'menu:activity')]),
    row([button('⛽ Gas', 'menu:gas'), button('⚙️ Settings', 'menu:settings')]),
  ];
  if (isOwner) rows.push(row([button('🛡️ Admin', 'menu:admin')]));
  // Packed into the FIRST row rather than added as a new one. With Admin present this menu is
  // already at Discord's 5-row ceiling, and a sixth row makes Discord reject the whole payload --
  // a security warning that silently blanks the menu would be worse than no warning at all.
  if (securityNeedsAttention(security)) {
    rows[0].components.unshift(button('🔐 Secure my account', 'menu:security', 'danger'));
  }
  return {
    content: '## GhostMint\nChoose a section below, or use a slash command directly if you already know it.'
      + securityBanner(security),
    components: rows,
  };
}

// Discord counterpart to Telegram's contractDetailsText (src/telegram/menus.js). Pure text only --
// callers attach whatever's actionable for the moment (Section AA's guided-flow screens prepend
// this as a header; nothing else needs it standalone anymore now that the bare-content detector
// starts the real flow instead of a static preview).
function contractDetailsText({ contractAddress, chain, chainLabel, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice }) {
  // Blank lines below group the card into identity / price / limits bands instead of one flat
  // run-on list -- mirrors src/telegram/menus.js's contractDetailsText.
  const lines = [
    collection?.name ? `## ${collection.name}` : '## Contract details',
    `\`${contractAddress}\``,
    `${chainEmojiTag(chain)}Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];
  if (soldOut) {
    lines.push(displayPrice ? `Status: Sold out — floor price ${displayPrice.eth} ETH` : "Status: Sold out. Floor price couldn't be determined from this contract.");
  } else {
    lines.push(priceUnknown ? 'Price: not exposed by this contract' : `Price: ${priceETH} per item`);
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
  return lines.join('\n');
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
// user reads on screen, so shifting it can never change when a mint actually fires. Mirrors
// src/telegram/menus.js's formatGmtPlus1.
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

// Section AD Tier 1 -- Discord counterpart to Telegram's collectionInfoCard: market cap, live
// floor, and volume alongside the existing mint-specific fields, shown as the mint_guided flow's
// real first screen (superseding Section AA's withDetailsHeader merge, the same way Section M's
// merge was superseded on Telegram) with "🪙 Mint Now" as one of several actions. stats is null
// until detectMintContract has been called with includeStats:true; every stats-derived line is
// simply omitted rather than shown as a placeholder when a field is unavailable. openSeaUrl is
// built by discordBot.js (from OPENSEA_CHAIN_SLUGS), not here, so this module stays free of a
// cross-directory import into src/mint/ -- null omits the button entirely.
// Section AF -- humanizes an OpenSea stage_type ("public_sale", "presale", ...) into a fallback
// label for a stage OpenSea didn't give its own human-written label. Mirrors
// src/telegram/menus.js's humanizeStageType/stageSummaryLine.
function humanizeStageType(stageType) {
  if (!stageType) return 'Phase';
  return stageType.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function stageSummaryLine(stage, sym) {
  const label = stage.label || humanizeStageType(stage.stageType);
  const price = stage.priceETH !== null && stage.priceETH !== undefined ? `${stage.priceETH} ${sym}` : 'price TBD';
  const cap = stage.maxPerWallet !== null && stage.maxPerWallet !== undefined ? ` · max ${stage.maxPerWallet}/wallet` : '';
  return `${label} — ${price}${cap}`;
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
// card -- the phase picker (openSeaPhasePicker) shows every schedulable stage regardless, up to
// Discord's own 25-option select limit, so nothing schedulable is actually hidden here, only
// summarized.
function phaseLines(stages, sym, now) {
  const lines = stages.slice(0, MAX_PHASE_LINES).map(stage => {
    const status = classifyStage(stage, now);
    const label = stage.label || humanizeStageType(stage.stageType);
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

function collectionInfoCard({ contractAddress, chain, chainLabel, chainSym, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice, stats, drop, openSeaUrl }) {
  const sym = chainSym || 'ETH';
  // Blank lines below group the card into identity / price / stats / limits / description bands --
  // mirrors src/telegram/menus.js's collectionInfoCard.
  const lines = [
    collection?.name ? `## ${collection.name}` : '## Contract details',
    `\`${contractAddress}\``,
    `${chainEmojiTag(chain)}Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
    '',
  ];

  if (soldOut) {
    lines.push(displayPrice ? `Status: Sold out — floor ${displayPrice.eth} ${sym}` : "Status: Sold out. Floor price couldn't be determined from this contract.");
  } else {
    lines.push(priceUnknown ? 'Mint price: not exposed by this contract' : `Mint price: ${priceETH} ${sym} per item`);
  }

  // Real column alignment needs a monospace run, which Discord only gives inside a fenced code
  // block -- padEnd against the widest label in THIS card's actual rows, not a fixed width, so a
  // card with just "Floor" isn't dragging three columns of dead padding. Market cap is deliberately
  // not a row here: stats.marketCap is floor price * totalMinted, a derived number that dresses up
  // the same floor price already shown above as if it were a second, independent metric.
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
      lines.push('', '### Stats', `\`\`\`\n${table}\n\`\`\``);
    }
  }

  // Section AF -- "can't you read the phases from OpenSea and the contract?" On-chain SeaDrop only
  // ever exposes the ONE currently-configured PublicDrop struct (the Opens/Opened line below), so it
  // can never say what's coming after that. drop is null unless OpenSea actually tracks this
  // contract as a drop -- omitted entirely rather than shown as a broken/empty section. Once sold
  // out there is nothing left for a phase to gate access to, so the section is dropped even if OpenSea
  // still hands back stale stage data for it. Shows every stage OpenSea knows about, not just
  // whichever two it names active/next -- a drop isn't capped at any fixed stage count.
  if (!soldOut && drop?.stages?.length) {
    lines.push('', `### Phases (${drop.stages.length})`, ...phaseLines(drop.stages, sym, Date.now()));
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
  if (collection?.description) lines.push('', collection.description.slice(0, 300));

  const utilityRow = [button('🔄 Refresh', 'flow:detailsrefresh')];
  if (openSeaUrl) utilityRow.push(urlButton('🔗 OpenSea', openSeaUrl));

  // Discord hard-caps a message at 5 action rows: Mint Now + Mint via OpenSea + Schedule for
  // OpenSea phase + the utility row (Refresh/OpenSea) + Cancel is the worst case, exactly 5 -- see
  // menuShape.test.js's pinned case for this combination. Copy CA was dropped entirely for the same
  // budget reason -- the contract address is already shown as inline code at the top of the card,
  // which Discord's own client already lets you tap-to-copy, so the button was a convenience
  // shortcut, not the only way to get it. Mint via OpenSea and Schedule for OpenSea phase are NOT
  // mutually exclusive -- a stage can be live right now while a later one is separately upcoming,
  // and both actions are genuinely useful at once; the generic on-chain "Schedule for opening"
  // fallback (no eligibility proof this app can construct itself) is the only one gated on OpenSea
  // having nothing to say at all. Sold out means there is nothing left to mint or schedule against,
  // so none of this block applies -- only the info-only utility/cancel rows below remain.
  const schedulable = (drop?.stages || []).filter(stage => stage.startTime && stage.startTime * 1000 > Date.now());
  const rows = [];
  if (!soldOut) {
    rows.push(row([button('🪙 Mint Now', 'flow:mintdetailscontinue', 'success')]));
    if (drop?.activeStage) {
      // Shown only when OpenSea confirms a stage is live right now -- there is nothing for it to
      // mint against otherwise.
      rows.push(row([button('🎫 Mint via OpenSea', 'flow:mintviaopensea')]));
    }
    if (schedulable.length > 0) {
      // A phase that hasn't opened yet has nothing to mint against -- being tapped-in and ready at
      // the exact open is what cuts the time wasted, not a pre-check OpenSea has no way to answer
      // ahead of time (see mintViaOpenSea's own notes). The count only shows once there's an actual
      // choice to make (see afterScheduleViaOpenSeaTap) -- a single upcoming stage schedules itself.
      const label = schedulable.length > 1 ? `🎫📅 Schedule OpenSea phase (${schedulable.length})` : '🎫📅 Schedule for OpenSea phase';
      rows.push(row([button(label, 'flow:scheduleviaopensea')]));
    } else if (opensInFuture) {
      rows.push(row([button('📅 Schedule for opening', 'flow:schedulesuggest', 'success')]));
    }
  }
  rows.push(row(utilityRow), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]));

  return { content: lines.join('\n'), components: rows };
}

// Section AF -- shown only when there's a genuine choice (see mintFlowDecision.afterScheduleViaOpenSeaTap);
// a single upcoming stage schedules itself with no picker at all. A select menu, not one button per
// stage, keeps this at Discord's actual limit (25 options) rather than the 5-row cap a button-per-
// stage layout would hit almost immediately -- same reasoning as walletMultiSelect's own choice of a
// select over buttons. The option VALUE carries the stage's index into drop.stages (not its OpenSea
// uuid -- irrelevant here, but kept consistent with Telegram's own byte-budget reason for using an
// index, see flow:scheduleviaopenseaphase's handler).
function openSeaPhasePicker(stages, sym) {
  const options = stages.map(stage => ({
    label: `${stage.label || humanizeStageType(stage.stageType)} — opens ${formatGmtPlus1(stage.startTime * 1000)}`.slice(0, 100),
    description: stageSummaryLine(stage, sym).slice(0, 100),
    value: String(stage.index),
  }));
  return {
    content: 'Which phase should this be scheduled against?',
    components: [select('flow:scheduleviaopenseaphase:select', options, 'Select a phase'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section AA -- Discord counterpart to Telegram's quantityStepPayload/Section L. A select menu
// (not a button row) so the custom_id stays a single fixed value; the wallet/quantity/price steps
// all follow this same shape so FLOW_CONTINUATIONS in discordBot.js only ever needs exact,
// unchanging custom_ids, matching how chainSelect/walletSelect already work.
function mintQuantitySelect({ maxPerWallet }) {
  const max = Math.max(1, Math.min(Number(maxPerWallet) || 1, 100));
  const quick = [...new Set([1, 2, 5, max].filter(value => value <= max))];
  const options = quick.map(value => ({ label: value === max ? `Max (${max})` : String(value), value: String(value) }));
  options.push({ label: '✏️ Custom amount', value: 'custom' });
  return {
    content: `How many would you like to mint? (max ${max} per wallet)`,
    components: [select('flow:mintqty:select', options, 'Select a quantity'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section AA -- Discord counterpart to Telegram's priceStepPayload (Section G's OpenSea-floor
// accept/manual choice). Manual entry always uses a modal (Discord has no plain-text flow-input
// step, unlike Telegram) -- see flow:pricemanual's handler in discordBot.js.
function mintPriceStep({ chainSym, displayPrice }) {
  const sym = chainSym || 'native currency';
  if (displayPrice) {
    return {
      content: `This contract does not expose a recognized price function. OpenSea suggests a floor price of ${displayPrice.eth} ${sym}. Use this as the mint price, or enter one yourself?`,
      components: [
        row([button(`✅ Use ${displayPrice.eth} ${sym}`, 'flow:priceaccept', 'success'), button('✏️ Enter manually', 'flow:pricemanual')]),
        row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]),
      ],
    };
  }
  return {
    content: `This contract does not expose a recognized price function. Enter the price per item in ${sym} (0 if free).`,
    components: [row([button('✏️ Enter price', 'flow:pricemanual')]), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section AA/O -- Discord counterpart to Telegram's gasTolerancePrompt (Round 8, Section AE was
// scoped to Telegram's guided /batch only at the time -- Discord's /batch-mint had no guided flow
// at all back then, so this step was never reachable there until the wallet multi-select follow-up
// exposed the same shared mintFlowDecision.afterPriceKnown path Telegram already used). Lets the
// user cap what this batch is willing to pay in gas without touching their account's own governance
// ceiling (shown here for context, never raised by this choice).
function gasTolerancePrompt({ currentGasGwei, ceilingGwei }) {
  const currentLine = currentGasGwei === null || currentGasGwei === undefined
    ? 'Current network gas price is unavailable right now.'
    : `Current network gas price: ${currentGasGwei} gwei.`;
  return {
    content: `⛽ Gas tolerance for this batch\n${currentLine}\nYour account's gas ceiling: ${ceilingGwei} gwei (this batch will never blow past it).\n\nWant a tighter cap just for this batch? Any wallet whose tx would exceed it gets skipped, not sent.`,
    components: [
      row([button(`✅ No extra limit (up to ${ceilingGwei} gwei)`, 'flow:gastoleranceaccept', 'success')]),
      row([button('✏️ Set my own gwei cap', 'flow:gastolerancemanual')]),
      row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]),
    ],
  };
}

// Section AA -- Discord counterpart to Telegram's mintConfirmation.
function mintConfirmation({ contractAddress, chainLabel, walletLabels, quantity = 1, priceETH, priceUnknown, maxGasGwei }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)`;
  // maxGasGwei only ever appears here for a batch (see afterGasToleranceResolved) -- undefined
  // means this confirm screen isn't reachable through that step at all (a plain /mint), so the
  // line is omitted entirely rather than shown as "not set" for a flow that was never asked.
  const gasLine = maxGasGwei === undefined ? '' : `\nGas tolerance: ${maxGasGwei === null ? 'no extra limit (account ceiling only)' : `up to ${maxGasGwei} gwei`}`;
  return {
    content: `## Confirm mint\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet(s): ${walletLabels.join(', ')}\nQuantity: ${quantity} each\n${priceLine}${gasLine}\n\nProceed?`,
    components: [row([button('✅ Confirm', 'flow:mintconfirm', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section AF follow-up -- Discord's mini schedule flow, triggered from the collection card's
// "Schedule for opening" action when a future startTime is detected. Unlike Telegram's full
// task_guided flow (Section S -- Discord guided task-schedule -- remains unbuilt), this only ever
// creates one task per tap: pasting the same contract again and tapping the button again is how a
// second phase gets scheduled here, there is no dedicated "add phase" continuation yet.
//
// A select menu (not button rows), same shape as mintQuantitySelect's quick-values-plus-custom
// pattern -- FLOW_CONTINUATIONS in discordBot.js matches exact custom_ids, and a select keeps this
// at one fixed custom_id with the choice carried in .values instead of needing one continuation
// entry per label. SeaDrop has no stage-type field anywhere in its protocol, only a bare
// dropStageIndex integer -- these labels are never a verified on-chain fact, just a naming
// shortcut, same caveat as Telegram's TASK_NAME_QUICK_PICKS in src/server.js.
function taskNameQuickPicks() {
  const options = [
    { label: '🔒 GTD', value: 'GTD' },
    { label: '🏃 FCFS', value: 'FCFS' },
    { label: '🌐 PUBLIC', value: 'PUBLIC' },
    { label: '✏️ Custom name', value: 'custom' },
  ];
  return {
    content: "Name this scheduled mint. The common phase labels below are just a shortcut -- unverified, since nothing on-chain says which stage is which -- a custom name works just as well.",
    components: [select('flow:taskname:select', options, 'Select a name'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, quantity, mintTime, priceETH, priceUnknown, viaOpenSea }) {
  // Section AF -- OpenSea's own response at execution time determines the real price for an
  // allowlist/GTD/FCFS stage; nothing scheduled up front could ever be the real number.
  const priceLine = viaOpenSea
    ? 'Price: determined by OpenSea at mint time (it resolves eligibility and price for this stage automatically)'
    : priceUnknown
      ? 'Price: not exposed by this contract'
      : `Price: ${priceETH} per item (read from the contract)`;
  const heading = viaOpenSea ? '## Confirm OpenSea-backed schedule' : '## Confirm scheduled mint';
  return {
    content: `${heading}\nName: ${name}\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet: ${walletLabel}\nQuantity: ${quantity || 1}\n${priceLine}\nFires: ${formatGmtPlus1(mintTime)}\n\nThis is not a reminder -- the bot signs and sends the mint itself at that moment.\n\nProceed?`,
    components: [row([button('✅ Schedule it', 'flow:taskconfirm', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section AA -- numeric-entry modal for custom quantity and manual price, sharing labelModal's
// text-input shape (Discord has no dedicated number input component; validated on submit exactly
// like Telegram's typed-number free-text steps already are).
function numberModal({ customId, title, placeholder = '' }) {
  return {
    custom_id: customId,
    title,
    components: [row([{
      type: TEXT_INPUT, custom_id: 'value', style: TEXT_STYLE.short,
      label: title, placeholder, required: true, max_length: 20,
    }])],
  };
}

// Tapping Mint used to go straight to a contract modal and then a SINGLE-wallet flow, so batch
// minting was reachable only by knowing the /batch-mint slash command existed. The guided batch
// flow was already built (multi:true -> wallet multi-select -> quantity -> price -> confirm); it
// simply had no button. This is that button.
function mintModeMenu() {
  return {
    content: '## Mint\nMint from one wallet, or the same drop from several at once.',
    components: [
      row([button('⚡ Single mint', 'menu:mint:single')]),
      row([button('🗂️ Batch mint', 'menu:mint:batch')]),
      row([button('⬅️ Back to menu', 'menu:main')]),
    ],
  };
}

// Batch import's collection card. Keys accumulate one modal at a time -- the "+ another" the owner
// asked for -- and the modal takes a PARAGRAPH, so somebody holding twenty keys pastes them in one
// go rather than tapping twenty times. That combination covers both halves of the request without
// a "how many?" step, which would only add a number to get wrong before you start.
//
// The keys themselves are never echoed back. Discord keeps message history, and a card that
// repeated what you just typed would put every key back on screen for anyone shoulder-surfing.
function batchImportMenu({ count = 0, chainLabel = '', dropped = 0 } = {}) {
  const ready = count > 0;
  return {
    content: `## Batch import${chainLabel ? ` · ${chainLabel}` : ''}\n`
      + (ready
        ? `**${count}** key${count === 1 ? '' : 's'} ready to import. Add more, or import what you have.

Each wallet's chain is detected from its own balances -- a batch can span chains.`
        : 'Add your first private key. You can paste several at once, one per line.')
      + (dropped ? `\n\n⚠️ ${dropped} key${dropped === 1 ? ' was' : 's were'} ignored — ${LIMITS.batchWalletImport} is the most one import can take. Import these, then start another batch.` : '')
      + "\n\n⚠️ Not recommended: keys pass through Discord's messaging systems and may remain in client history.",
    components: [
      row([button(ready ? '➕ Add more keys' : '🔑 Add keys', 'wallet:batch-import:add', 'danger')]),
      row([
        button(ready ? `✅ Import ${count}` : '✅ Import', 'wallet:batch-import:confirm', 'success', undefined, !ready),
        button('❌ Cancel', 'flow:cancel:ask', 'secondary'),
      ]),
    ],
  };
}
// Buttons are PACKED into rows, not one per row. Discord allows at most 5 action rows per
// message and rejects the whole payload -- silently, from the user's side -- when there are more.
// One-button-per-row put this menu at 6 rows before Batch import was added and 7 after, which is
// why tapping Wallets appeared to load and then do nothing at all. Guarded by menuShape.test.js.
// Discord verifies through a MODAL rather than a chat prompt: modal input never becomes a message
// and never enters channel history, which makes this genuinely safer than the Telegram equivalent
// rather than merely mitigated. Same password as the dashboard; no second one exists.
const GATE_ACTION_LABELS = {
  mint: 'mint', schedule: 'schedule a mint', exportkey: 'export a private key', removewallet: 'remove a wallet', send: 'send funds',
  batchimport: 'import wallets', importwallet: 'import a wallet',
  walletlist: 'list your wallets', balance: 'check a balance', activity: 'see your activity',
};

function gateUnlockCard({ action }) {
  const what = GATE_ACTION_LABELS[action] || 'do that';
  // Offered on the spot rather than buried in settings, with what it costs, so it reads as a
  // choice rather than a shortcut.
  const mintHint = action === 'mint'
    ? '\n\n⚡ **Minting feels slow with this on?** Switch the password off for minting only:'
      + ' Dashboard → **Settings** → **Password gate** → **Ask before minting**. Everything else stays'
      + ' protected. The risk: anyone who reaches this chat could then spend from your wallets on a'
      + ' contract of their choosing, without knowing your password.'
    : '';
  return {
    content: `## 🔒 Locked\nUnlock to ${what}. This is the same password the dashboard uses, and it stays unlocked here for 10 minutes.${mintHint}`,
    components: [row([
      button('🔓 Enter password', 'gate:unlock:open', 'success'),
      button('❌ Cancel', 'flow:cancel:ask', 'secondary'),
    ])],
  };
}

function walletsMenu() {
  return {
    content: '## Wallets\nGenerating a new wallet server-side is recommended over importing an existing key.',
    components: [
      row([button('📋 List wallets', 'wallet:list'), button('💰 Check balance', 'wallet:balance:pick')]),
      row([button('➕ Create wallet', 'wallet:create:start', 'success'), button('📥 Import wallet', 'wallet:import:start'), button('📥📥 Batch import', 'wallet:batch-import:start')]),
      row([button('🗑️ Remove wallet', 'wallet:remove:pick', 'danger'), button('⬅️ Back to menu', 'menu:main')]),
    ],
  };
}

function settingsMenu({ isOwner = false } = {}) {
  const rows = [
    row([button('🔗 Enter a link code from Telegram', 'link:enter')]),
    row([button('🎛️ Transaction mode', 'menu:mode')]),
  ];
  if (isOwner) rows.push(row([button('🛡️ Admin console', 'menu:admin')]));
  rows.push(row([button('⬅️ Back to menu', 'menu:main')]));
  return { content: '## Settings', components: rows };
}

// Section O -- the "Transaction mode" button had no button/menu path at all: /mode worked fine as
// a slash command, but was only reachable by already knowing the command and an exact preset name.
// Same 4 presets/labels as Telegram's already-shipped MODE_META (src/telegram/menus.js) -- kept in
// sync by hand since the two platforms build their option lists in entirely different shapes.
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

function modeMenu({ currentKey, presets, advancedModesAllowed = false }) {
  const rows = presets
    .filter(preset => advancedModesAllowed || !GATED_PRESET_KEYS.includes(preset.key))
    .map(preset => {
      const meta = MODE_META[preset.key] || { label: preset.displayName, hint: '' };
      return row([button(`${preset.key === currentKey ? '✅ ' : ''}${meta.label} · ${meta.hint}`, `mode:pick:${preset.key}`)]);
    });
  rows.push(row([button('⬅️ Back to settings', 'menu:settings')]));
  const currentLabel = MODE_META[currentKey]?.label || 'none selected';
  const lockedNote = advancedModesAllowed ? '' : '\n\n🔒 Degen and Fast require group or admin access.';
  return {
    content: `## 🎛️ Transaction mode\nCurrent mode: **${currentLabel}**\n\nControls confirmation prompts and how hard this thing sends gas on every mint. Ceilings and forced simulation always have the final say, no matter which mode you pick.${lockedNote}`,
    components: rows,
  };
}

function placeholderMenu(title, hint) {
  return { content: `## ${title}\n${hint}`, components: [row([button('⬅️ Back to menu', 'menu:main')])] };
}

// Real per-chain brand marks, uploaded once as application emojis (bot-wide -- usable in any guild
// the bot is in, unlike a per-server emoji upload). {id, name} is exactly the shape Discord's
// component `emoji` field wants for a custom emoji (a plain unicode char would go in `name` alone,
// but a custom one needs both). CHAIN_EMOJI_TAG below derives the inline `<:name:id>` form for
// embedding the same icon directly in message content, next to a "Chain: X" line.
const CHAIN_EMOJI = {
  ethereum: { id: '1539151972245049435', name: 'ethereum' },
  base: { id: '1539151974250061904', name: 'base' },
  arbitrum: { id: '1539151976586018848', name: 'arbitrum' },
  polygon: { id: '1539151979220181113', name: 'polygon' },
  robinhood: { id: '1539151981182976020', name: 'robinhood' },
};

function chainEmojiTag(chain) {
  const emoji = CHAIN_EMOJI[chain];
  return emoji ? `<:${emoji.name}:${emoji.id}> ` : '';
}

// Used only for wallet create/import -- a private key or seed phrase is chain-agnostic within EVM
// (see telegramMenus.chainPicker's matching note), so five near-identical options for one real
// choice was noise, not a real decision. Solana is shown, not hidden, so this doesn't need to
// change shape again the day real Solana support lands -- picking it today explains why it can't
// proceed yet instead of silently doing nothing. Discord select-menu options have no per-option
// disabled state, so "coming soon" is handled the same way as everything else that isn't ready: a
// distinct value the caller routes to an explanation rather than a real chain.
function chainSelect(supportedChains, chains, { customId = 'flow:chain:select', note } = {}) {
  const options = [
    { label: 'EVM', value: 'ethereum', emoji: CHAIN_EMOJI.ethereum || undefined },
    { label: 'Solana (coming soon)', value: 'solana-soon' },
  ];
  return {
    content: `${note ? `${note}\n` : ''}Choose a network:`,
    components: [select(customId, options, 'Select a network'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Groups chain-switch buttons 5-per-row -- Discord's own hard cap on buttons in a single action
// row (not a stylistic choice the way Telegram's 3-per-row chunking is), so this stays correct if
// a 6th chain is ever added instead of silently erroring the whole interaction.
function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

// Section O -- Discord counterpart to Telegram's already-shipped gasMenu (Round 1): the button
// performs the same botCommands.gas() lookup the /gas command uses and shows the result directly,
// rather than replying "use /gas chain:<chain>".
function gasMenu({ chain, fees, supportedChains, chains }) {
  const chainButtons = supportedChains.map(value =>
    button(chains[value]?.name || value, `gas:chain:${value}`, value === chain ? 'success' : 'secondary', CHAIN_EMOJI[value]));
  const rows = chunk(chainButtons, 5).map(row_ => row(row_));
  rows.push(row([button('⬅️ Back to menu', 'menu:main')]));
  const readout = fees
    ? `Safe: ${fees.safeGasPriceGwei ?? 'unavailable'} Gwei\nStandard: ${fees.gasPriceGwei ?? 'unavailable'} Gwei\nFast: ${fees.maxFeePerGasGwei ?? 'unavailable'} Gwei`
    : "Couldn't fetch gas prices for this chain right now.";
  return {
    content: `## ⛽ Gas check: ${chains[chain]?.name || chain}\n${readout}`,
    components: rows,
  };
}

// Section O -- Discord counterpart to the activity half of Telegram's already-shipped parity
// buttons: performs the same botCommands.activityPage() call /activity uses instead of telling the
// user to go type the command. No Prev button on page 1; no Next once the last page is reached.
function activityMenu(page) {
  const lines = page.items.length
    ? page.items.map(item => `${item.status}: ${item.title}${item.address ? ` to \`${item.address}\`` : ''} — ${item.walletLabel}`).join('\n')
    : 'No activity yet.';
  const nav = [];
  if (page.page > 1) nav.push(button('◀️ Prev', `activity:page:${page.page - 1}`));
  if (page.page < page.totalPages) nav.push(button('▶️ Next', `activity:page:${page.page + 1}`));
  const rows = nav.length ? [row(nav)] : [];
  rows.push(row([button('⬅️ Back to menu', 'menu:main')]));
  return {
    content: `## 📊 Activity (page ${page.page}/${page.totalPages}, ${page.total} total)\n${lines}`,
    components: rows,
  };
}

// Section O -- performs the same lookup /task list already does, same Prev/Next paging shape as
// activityMenu above.
function tasksMenu(page) {
  const lines = page.items.length
    ? page.items.map(task => `${task.viaOpenSea ? '🎫 ' : ''}${task.name} [${task.status}] — ${formatGmtPlus1(task.mintTime)} — ${task.id}`).join('\n')
    : 'No scheduled tasks.';
  const nav = [];
  if (page.page > 1) nav.push(button('◀️ Prev', `tasks:page:${page.page - 1}`));
  if (page.page < page.totalPages) nav.push(button('▶️ Next', `tasks:page:${page.page + 1}`));
  const rows = nav.length ? [row(nav)] : [];
  rows.push(row([button('🗓️ Schedule mint', 'menu:mint'), button('⬅️ Back to menu', 'menu:main')]));
  return {
    content: `## 🗓️ Tasks (page ${page.page}/${page.totalPages}, ${page.total} total)\n${lines}`,
    components: rows,
  };
}

// Section O -- performs the same lookup /sniper list already does, matching its exact list format
// (Post-confirmation copying disclaimer included) rather than replying "use /sniper list".
function snipersMenu(snipers) {
  const lines = snipers.length
    ? snipers.map(item => `${item.label} [${item.active ? 'active' : 'inactive'}] — ${item.id}`).join('\n')
    : 'No matching snipers.';
  return {
    content: `🎯 Post-confirmation copying only; not mempool front-running.\n${lines}`,
    components: [row([button('➕ Create sniper', 'sniper:create:start')]), row([button('⬅️ Back to menu', 'menu:main')])],
  };
}

// Guided sniper-creation flow (mirrors src/sniper/sniperFlowDecision.js's step ordering).
// Chain/wallet steps reuse chainSelect/walletSelect as-is; only the tolerance prompt/modal and the
// confirm screen are new here.

// Every field here already has a working default in validateSniper -- accepting them is one tap;
// customizing opens sniperToleranceModal below. Mirrors mint_guided's own gasTolerancePrompt shape
// (accept-default button vs a "set my own" button that opens a modal).
function sniperTolerancePrompt(defaults) {
  return {
    content: `⛽ Fee tolerance & caps\nDefaults: max gas **${defaults.maxGasGwei} gwei** · max value per fire **${defaults.maxValueETH} ETH** · daily spend cap **${defaults.dailySpendingCapETH} ETH**.\n\nUse these, or set your own?`,
    components: [row([
      button('✅ Use these defaults', 'flow:snipertoleranceaccept', 'success'),
      button('✏️ Set my own', 'flow:snipertolerancemanual'),
    ])],
  };
}

// Label and target address land in one modal, not two -- a modal cannot be opened directly from
// another modal's own submit handler (only from a button/select interaction), the same constraint
// watchConfigModal's own "combine several fields into one modal" comment already documents. Both
// are required, unlike the tolerance modal below.
function sniperDetailsModal() {
  return {
    custom_id: 'flow:snipercreate:submit', title: 'New sniper',
    components: [
      row([{ type: TEXT_INPUT, custom_id: 'label', style: TEXT_STYLE.short, label: 'Label', placeholder: 'A name to recognize this sniper by', required: true, max_length: 100 }]),
      row([{ type: TEXT_INPUT, custom_id: 'targetAddress', style: TEXT_STYLE.short, label: 'Target wallet address to copy', placeholder: '0x...', required: true, max_length: 42 }]),
    ],
  };
}

// All three fields are optional (validateSniper already has a working default for each), unlike
// watchConfigModal's fields which are always required -- shown as the placeholder text instead, so
// leaving a field blank on submit means "use the default", not a rejected empty required field.
function sniperToleranceModal(defaults) {
  const fields = [
    { id: 'maxGasGwei', label: 'Max gas (gwei)', hint: `Default ${defaults.maxGasGwei}` },
    { id: 'maxValueETH', label: 'Max value per fire (ETH)', hint: `Default ${defaults.maxValueETH}` },
    { id: 'dailySpendingCapETH', label: 'Daily spending cap (ETH)', hint: `Default ${defaults.dailySpendingCapETH}` },
  ];
  const rows = fields.map(field => row([{
    type: TEXT_INPUT, custom_id: field.id, style: TEXT_STYLE.short,
    label: field.label, placeholder: field.hint, required: false, max_length: 20,
  }]));
  return { custom_id: 'flow:snipertolerance:submit', title: 'Fee tolerance & caps', components: rows };
}

function sniperConfirmation(data) {
  const fmt = (value, fallback) => (value === undefined || value === null || Number.isNaN(value) ? `default (${fallback})` : value);
  return {
    content: `## 🎯 Confirm sniper\nLabel: ${data.label}\nTarget: \`${data.targetAddress}\`\nChain: ${data.chain}\nWallet: ${data.walletLabel}\nMax gas: ${fmt(data.maxGasGwei, '200 gwei')}\nMax value/fire: ${fmt(data.maxValueETH, '0.1 ETH')}\nDaily cap: ${fmt(data.dailySpendingCapETH, '0.25 ETH')}\n\nCreate this sniper?`,
    components: [row([button('✅ Create', 'flow:sniperconfirm', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Section O -- /admin itself is a write-only dispatcher over 20+ owner actions with no single
// "the" read to mirror, so this instead surfaces governance.dashboardOverview (already built and
// already owner-gated -- the same data the web dashboard's own admin page shows), mirroring
// Telegram's counterpart. Per-user detail and preset tuning stay on the dashboard/text commands;
// this is a summary. Wei figures arrive already formatted to ETH strings (see
// governance/adminOverviewFormat.js), same shared formatting Telegram's adminOverviewMenu uses.
function adminOverviewMenu({ metrics, groups }) {
  const groupLines = groups.length
    ? groups.map(g => `• ${g.name} — gas ≤${g.gasCeilingGwei ?? 'no ceiling'} gwei, tx ≤${g.maxTransactionValueEth ?? 'no ceiling'}, daily ≤${g.dailySpendingBudgetEth ?? 'no ceiling'}`).join('\n')
    : 'No groups configured yet.';
  return {
    content: `## 🛡️ Admin overview\n`
      + `Users: ${metrics.totalUsers} total · ${metrics.activeAnyPlatform24h} active in 24h · ${metrics.owners} owner${metrics.owners === 1 ? '' : 's'} (${metrics.rootOwners} root)\n`
      + `Groups: ${metrics.groups} · Linked accounts: ${metrics.linkedAccounts}\n\n`
      + `### Groups\n${groupLines}\n\n`
      + `Per-user detail and every other action: \`/admin action:<action> confirm:true\`.`,
    components: [row([button('⬅️ Back to menu', 'menu:main')])],
  };
}

function walletSelect(wallets, { customId, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const options = wallets.map(w => ({ label: `${w.label} (${w.chain})`, value: w.label, emoji: CHAIN_EMOJI[w.chain] || undefined }));
  return { content: 'Choose a wallet:', components: [select(customId, options, 'Select a wallet'), row([button('⬅️ Back to menu', 'menu:wallets')])] };
}

// Batch mint (multi:true) needs more than one wallet. Discord's select menu supports checking
// several options in one open-dropdown session, but each *submission* (closing the dropdown) is
// its own interaction carrying only whatever was checked in that session -- picking one wallet,
// having the dropdown close, then reopening it does NOT remember the earlier pick unless this menu
// marks it `default: true`. So this stays open across submissions: every select fires flow state
// forward via `selectedLabels`, re-renders this same menu with those options pre-checked, and a
// separate Continue button (mirroring Telegram's toggle-then-flow:walletcontinue shape, the closest
// real equivalent Discord has) is what actually advances the flow -- not the select itself.
function walletMultiSelect(wallets, selectedLabels, { customId, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  if (wallets.length < MIN_BATCH_WALLETS) {
    return {
      content: `## Batch mint needs ${MIN_BATCH_WALLETS} wallets
You have ${wallets.length}. A batch of one is just a single mint -- use that instead, or add another wallet first.`,
      components: [row([button('🎯 Single mint instead', 'menu:mint:single', 'success'), button('➕ Add a wallet', 'wallet:create:start'), button('⬅️ Back', 'menu:main')])],
    };
  }
  const options = wallets.map(w => ({ label: `${w.label} (${w.chain})`, value: w.label, emoji: CHAIN_EMOJI[w.chain] || undefined, default: selectedLabels.includes(w.label) }));
  const continueRow = selectedLabels.length >= MIN_BATCH_WALLETS
    ? row([button(`▶️ Continue with ${selectedLabels.length}`, 'flow:mintwalletmulti:continue', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])
    : row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]);
  return {
    content: selectedLabels.length
      ? `Choose every wallet to include in this batch.\nSelected so far: ${selectedLabels.join(', ')}`
      : 'Choose every wallet to include in this batch:',
    components: [select(customId, options, `Select at least ${MIN_BATCH_WALLETS} wallets`, { minValues: MIN_BATCH_WALLETS, maxValues: wallets.length }), continueRow],
  };
}

// Watch-rule guided create flow -- Discord counterpart to the Telegram menu functions of the same
// shape, sharing src/social/watchRuleFlowDecision.js for the "what config field is next" core.
const WATCH_TYPE_META = {
  twitter_account: { label: 'Twitter — Account' },
  twitter_keyword: { label: 'Twitter — Keyword' },
  discord_channel: { label: 'Discord — Channel' },
  discord_keyword: { label: 'Discord — Keyword' },
  farcaster_account: { label: 'Farcaster — Account' },
  farcaster_keyword: { label: 'Farcaster — Keyword' },
};
const WATCH_METHOD_META = {
  official_api: { label: 'Official API', description: "direct platform API using this bot's credentials" },
  managed_service: { label: 'Managed service', description: 'an operator-selected gateway; no credentials needed' },
  scraper: { label: 'Scraper URL', description: 'a credential-free HTTP(S) URL you provide' },
};

function watchTypeSelect() {
  const options = Object.entries(WATCH_TYPE_META).map(([type, meta]) => ({ label: meta.label, value: type }));
  return {
    content: 'What do you want to watch?',
    components: [select('flow:watchtype:select', options, 'Select what to watch'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

function watchMethodSelect() {
  const options = Object.entries(WATCH_METHOD_META).map(([method, meta]) => ({ label: meta.label, value: method, description: meta.description }));
  return {
    content: 'How should this rule get its data?',
    components: [select('flow:watchmethod:select', options, 'Select a method'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

// Collects every remaining config field (at most 2 for any type/method combination today: one
// type-specific field plus sourceUrl for the scraper method) in a single modal, rather than one
// modal per field -- Discord modals can only be opened in response to a component interaction,
// not chained directly off another modal's submission, so one combined modal sidesteps that
// entirely instead of relying on it. `prompts` is CONFIG_FIELD_PROMPTS from
// src/social/watchRuleFlowDecision.js, passed in by the caller so this file doesn't need to
// import across from src/social/ -- mirrors how server.js does the same lookup for Telegram's
// menus.js.
function watchConfigModal(fields, prompts) {
  const rows = fields.slice(0, 5).map(field => {
    const meta = prompts[field] || { label: field, hint: '' };
    return row([{
      type: TEXT_INPUT, custom_id: field, style: TEXT_STYLE.short,
      label: meta.label.slice(0, 45), placeholder: meta.hint.slice(0, 100), required: true,
      max_length: field === 'keywords' ? 500 : field === 'sourceUrl' ? 2048 : 100,
    }]);
  });
  return { custom_id: 'flow:watchconfig:submit', title: 'Watch rule details', components: rows };
}

function watchRuleConfirmation({ name, type, method, config }) {
  const configLines = Object.entries(config || {})
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('\n');
  return {
    content: `## Confirm watch rule\nName: ${name}\nWatching: ${WATCH_TYPE_META[type]?.label || type}\nMethod: ${WATCH_METHOD_META[method]?.label || method}\n${configLines}\n\nCreate this rule?`,
    components: [row([button('✅ Create rule', 'flow:watchconfirm', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

function watchRulesList(rules) {
  if (!rules.length) {
    return { content: 'No social watch rules yet.', components: [row([button('➕ Add a watch rule', 'watch:add:start', 'success')]), row([button('⬅️ Back to menu', 'menu:main')])] };
  }
  const options = rules.map(rule => ({ label: `${rule.enabled ? '🟢' : '⚪'} ${rule.name}`.slice(0, 100), value: rule.id }));
  return {
    content: 'Your social watch rules:',
    components: [select('watch:manage:select', options, 'Select a rule to manage'), row([button('➕ Add a watch rule', 'watch:add:start', 'success')]), row([button('⬅️ Back to menu', 'menu:main')])],
  };
}

function watchRuleActions(rule) {
  return {
    content: `## ${rule.name}\nStatus: ${rule.enabled ? '🟢 enabled' : '⚪ disabled'}\nWatching: ${WATCH_TYPE_META[rule.type]?.label || rule.type}\nMethod: ${WATCH_METHOD_META[rule.method]?.label || rule.method}\nID: \`${rule.id}\``,
    components: [
      row([button(rule.enabled ? '⏸ Disable' : '▶️ Re-enable', `watch:toggle:${rule.id}`, rule.enabled ? 'secondary' : 'success')]),
      row([button('🗑️ Remove', `watch:remove:ask:${rule.id}`, 'danger')]),
      row([button('⬅️ Back to list', 'watch:list')]),
    ],
  };
}

function confirmRemoveWatchRule(rule) {
  return {
    content: `Remove watch rule ${rule.name}? This cannot be undone.`,
    components: [row([
      button('✅ Yes, remove it', `watch:remove:do:${rule.id}`, 'danger'),
      button('❌ No, keep it', `watch:manage:${rule.id}`),
    ])],
  };
}

function confirmRemoveWallet(label) {
  return {
    content: `Remove wallet ${label}? This cannot be undone.`,
    components: [row([
      button('✅ Yes, remove it', `wallet:remove:do:${label}`, 'danger'),
      button('❌ No, keep it', 'menu:wallets'),
    ])],
  };
}

// Discord counterpart to Telegram's confirmCancelTask -- same task:cancel:ask:<id>/task:cancel:do:<id>
// step shape, so both platforms' handlers can share the exact same commands.tasks/controlTask calls.
function confirmCancelTask(task) {
  return {
    content: `Cancel **${task.name}**? This cannot be undone.`,
    components: [row([
      button('✅ Yes, cancel it', `task:cancel:do:${task.id}`, 'danger'),
      button('❌ No, keep it', 'menu:main'),
    ])],
  };
}

function labelModal({ customId, title, placeholder = '', style = 'short', maxLength = 64 }) {
  return {
    custom_id: customId,
    title,
    components: [row([{
      type: TEXT_INPUT, custom_id: 'value', style: TEXT_STYLE[style] || TEXT_STYLE.short,
      label: title, placeholder, required: true, max_length: maxLength,
    }])],
  };
}

module.exports = {
  button, row, select, mainMenu, mintModeMenu, batchImportMenu, gateUnlockCard,
  securityBanner, securityNeedsAttention, securitySetupCard, walletsMenu, settingsMenu, placeholderMenu,
  chainSelect, walletSelect, walletMultiSelect, confirmRemoveWallet, confirmCancelTask, labelModal, gasMenu, activityMenu, tasksMenu, snipersMenu, adminOverviewMenu,
  sniperDetailsModal, sniperTolerancePrompt, sniperToleranceModal, sniperConfirmation,
  modeMenu, MODE_META,
  contractDetailsText, collectionInfoCard, openSeaPhasePicker, humanizeStageType, mintQuantitySelect, mintPriceStep, gasTolerancePrompt, mintConfirmation, numberModal,
  taskNameQuickPicks, taskConfirmation,
  watchTypeSelect, watchMethodSelect, watchConfigModal, watchRuleConfirmation,
  watchRulesList, watchRuleActions, confirmRemoveWatchRule,
  formatGmtPlus1,
};
