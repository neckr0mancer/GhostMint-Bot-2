// Pure component-building functions for the Milestone 15c Discord redesign, mirroring
// src/telegram/menus.js: every function takes plain data in and returns a raw, Discord
// API-shaped payload ({ content, components } with numeric `type`s and `custom_id`s), not
// discord.js builder instances. discord.js accepts already-API-shaped objects for
// interaction.reply/update/showModal, so this stays fully unit-testable without loading
// discord.js, and discordBot.js (the composition root) is responsible only for wiring.

const ROW = 1;
const BUTTON = 2;
const SELECT = 3;
const TEXT_INPUT = 4;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const TEXT_STYLE = { short: 1, paragraph: 2 };

function button(label, customId, style = 'secondary', emoji) {
  const value = { type: BUTTON, style: BUTTON_STYLE[style] || BUTTON_STYLE.secondary, custom_id: customId, label };
  if (emoji) value.emoji = emoji;
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

function mainMenu({ isOwner = false } = {}) {
  const rows = [
    row([button('👛 Wallets', 'menu:wallets'), button('⚡ Mint', 'menu:mint')]),
    row([button('🗓️ Tasks', 'menu:tasks'), button('🎯 Snipers', 'menu:snipers')]),
    row([button('📡 Watch rules', 'menu:watch'), button('📊 Activity', 'menu:activity')]),
    row([button('⛽ Gas', 'menu:gas'), button('⚙️ Settings', 'menu:settings')]),
  ];
  if (isOwner) rows.push(row([button('🛡️ Admin', 'menu:admin')]));
  return { content: '## GhostMint\nChoose a section below, or use a slash command directly if you already know it.', components: rows };
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
function formatGmtPlus1(value) {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() + 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} GMT+1`;
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
  // contract as a drop -- omitted entirely rather than shown as a broken/empty section.
  if (drop && (drop.activeStage || drop.nextStage || drop.stages.length > 1)) {
    const phaseLines = [];
    if (drop.stages.length > 1) phaseLines.push(`${drop.stages.length} phases total`);
    if (drop.activeStage) {
      const endsAt = drop.activeStage.endTime ? ` · ends ${formatGmtPlus1(drop.activeStage.endTime * 1000)}` : '';
      phaseLines.push(`🟢 Live: ${stageSummaryLine(drop.activeStage, sym)}${endsAt}`);
    }
    if (drop.nextStage) {
      const opensAt = drop.nextStage.startTime ? ` · opens ${formatGmtPlus1(drop.nextStage.startTime * 1000)}` : '';
      phaseLines.push(`🔵 Next: ${stageSummaryLine(drop.nextStage, sym)}${opensAt}`);
    }
    lines.push('', '### Phases (via OpenSea)', ...phaseLines);
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

  const rows = [row([button('🪙 Mint Now', 'flow:mintdetailscontinue', 'success')])];
  if (opensInFuture) rows.push(row([button('📅 Schedule for opening', 'flow:schedulesuggest', 'success')]));
  rows.push(row(utilityRow), row([button('📋 Copy CA', 'flow:copyca')]), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]));

  return { content: lines.join('\n'), components: rows };
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

function taskConfirmation({ name, contractAddress, chainLabel, walletLabel, quantity, mintTime, priceETH, priceUnknown }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract'
    : `Price: ${priceETH} per item (read from the contract)`;
  return {
    content: `## Confirm scheduled mint\nName: ${name}\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet: ${walletLabel}\nQuantity: ${quantity || 1}\n${priceLine}\nFires: ${formatGmtPlus1(mintTime)}\n\nThis is not a reminder -- the bot signs and sends the mint itself at that moment.\n\nProceed?`,
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

function walletsMenu() {
  return {
    content: '## Wallets\nGenerating a new wallet server-side is recommended over importing an existing key.',
    components: [
      row([button('📋 List wallets', 'wallet:list')]),
      row([button('➕ Create wallet', 'wallet:create:start', 'success')]),
      row([button('📥 Import wallet', 'wallet:import:start')]),
      row([button('💰 Check balance', 'wallet:balance:pick')]),
      row([button('🗑️ Remove wallet', 'wallet:remove:pick', 'danger')]),
      row([button('⬅️ Back to menu', 'menu:main')]),
    ],
  };
}

function settingsMenu({ isOwner = false } = {}) {
  const rows = [row([button('🔗 Enter a link code from Telegram', 'link:enter')])];
  if (isOwner) rows.push(row([button('🛡️ Admin console', 'menu:admin')]));
  rows.push(row([button('⬅️ Back to menu', 'menu:main')]));
  return { content: '## Settings', components: rows };
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

function chainSelect(supportedChains, chains, { customId = 'flow:chain:select' } = {}) {
  const options = supportedChains.map(chain => ({
    label: chains[chain]?.name || chain, value: chain,
    emoji: CHAIN_EMOJI[chain] || undefined,
  }));
  return {
    content: 'Choose a chain:',
    components: [select(customId, options, 'Select a chain'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
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
    ? page.items.map(item => `${item.status}: ${item.title} — ${item.walletLabel}`).join('\n')
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
    ? page.items.map(task => `${task.name} [${task.status}] — ${formatGmtPlus1(task.mintTime)} — ${task.id}`).join('\n')
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
    components: [row([button('⬅️ Back to menu', 'menu:main')])],
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

// Batch mint (multi:true) needs more than one wallet -- Discord's select menu supports true
// multi-select in one component (min_values/max_values), unlike Telegram's toggle-then-Continue
// button list (no equivalent component exists there), so this is a single tap-to-submit select
// rather than a dedicated multi-step picker.
function walletMultiSelect(wallets, { customId, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const options = wallets.map(w => ({ label: `${w.label} (${w.chain})`, value: w.label, emoji: CHAIN_EMOJI[w.chain] || undefined }));
  return {
    content: 'Choose every wallet to include in this batch:',
    components: [select(customId, options, 'Select one or more wallets', { minValues: 1, maxValues: wallets.length }), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
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
  button, row, select, mainMenu, mintModeMenu, walletsMenu, settingsMenu, placeholderMenu,
  chainSelect, walletSelect, walletMultiSelect, confirmRemoveWallet, labelModal, gasMenu, activityMenu, tasksMenu, snipersMenu, adminOverviewMenu,
  contractDetailsText, collectionInfoCard, mintQuantitySelect, mintPriceStep, gasTolerancePrompt, mintConfirmation, numberModal,
  taskNameQuickPicks, taskConfirmation,
  watchTypeSelect, watchMethodSelect, watchConfigModal, watchRuleConfirmation,
  watchRulesList, watchRuleActions, confirmRemoveWatchRule,
  formatGmtPlus1,
};
