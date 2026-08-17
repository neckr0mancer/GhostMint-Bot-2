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

function button(label, customId, style = 'secondary') {
  return { type: BUTTON, style: BUTTON_STYLE[style] || BUTTON_STYLE.secondary, custom_id: customId, label };
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

function select(customId, options, placeholder) {
  return row([{ type: SELECT, custom_id: customId, placeholder, options }]);
}

function mainMenu({ isOwner = false } = {}) {
  const rows = [
    row([button('👛 Wallets', 'menu:wallets', 'primary'), button('⚡ Mint', 'menu:mint')]),
    row([button('🗓️ Tasks', 'menu:tasks'), button('🎯 Snipers', 'menu:snipers')]),
    row([button('📡 Watch rules', 'menu:watch'), button('📊 Activity', 'menu:activity')]),
    row([button('⛽ Gas', 'menu:gas'), button('⚙️ Settings', 'menu:settings')]),
  ];
  if (isOwner) rows.push(row([button('🛡️ Admin', 'menu:admin')]));
  return { content: '**GhostMint**\nChoose a section below, or use a slash command directly if you already know it.', components: rows };
}

// Discord counterpart to Telegram's contractDetailsText (src/telegram/menus.js). Pure text only --
// callers attach whatever's actionable for the moment (Section AA's guided-flow screens prepend
// this as a header; nothing else needs it standalone anymore now that the bare-content detector
// starts the real flow instead of a static preview).
function contractDetailsText({ contractAddress, chainLabel, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice }) {
  const lines = [collection?.name ? `**${collection.name}**` : '**Contract details**', `\`${contractAddress}\``,
    `Chain: ${chainLabel}`, `Type: ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`];
  if (soldOut) {
    lines.push(displayPrice ? `Status: Sold out — floor price ${displayPrice.eth} ETH` : 'Status: Sold out — floor price unavailable');
  } else {
    lines.push(priceUnknown ? 'Price: not exposed by this contract' : `Price: ${priceETH} per item`);
  }
  if (maxPerWallet !== null && maxPerWallet !== undefined) lines.push(`Max per wallet: ${maxPerWallet}`);
  if (maxSupply !== null && maxSupply !== undefined) lines.push(`Max supply: ${maxSupply}`);
  if (startTime) {
    const opensAt = new Date(startTime * 1000).toISOString();
    lines.push(startTime * 1000 > Date.now() ? `Opens: ${opensAt} UTC` : `Opened: ${opensAt} UTC`);
  }
  return lines.join('\n');
}

// Rounds to 4 decimal places for display -- enough precision to distinguish real mint/floor
// prices without spilling a raw wei-derived float's trailing digits onto the card.
function formatEthAmount(value, sym) {
  if (value === null || value === undefined) return null;
  return `${Math.round(value * 10_000) / 10_000} ${sym || 'ETH'}`;
}

// Section AD Tier 1 -- Discord counterpart to Telegram's collectionInfoCard: market cap, live
// floor, and volume alongside the existing mint-specific fields, shown as the mint_guided flow's
// real first screen (superseding Section AA's withDetailsHeader merge, the same way Section M's
// merge was superseded on Telegram) with "🪙 Mint Now" as one of several actions. stats is null
// until detectMintContract has been called with includeStats:true; every stats-derived line is
// simply omitted rather than shown as a placeholder when a field is unavailable. openSeaUrl is
// built by discordBot.js (from OPENSEA_CHAIN_SLUGS), not here, so this module stays free of a
// cross-directory import into src/mint/ -- null omits the button entirely.
function collectionInfoCard({ contractAddress, chainLabel, chainSym, isSeaDrop, priceETH, priceUnknown, maxSupply, maxPerWallet, startTime, collection, soldOut, displayPrice, stats, openSeaUrl }) {
  const sym = chainSym || 'ETH';
  const lines = [
    collection?.name ? `**${collection.name}**` : '**Contract details**',
    `\`${contractAddress}\``,
    `Chain: ${chainLabel} · ${isSeaDrop ? 'SeaDrop drop' : 'Standard mint(uint256)'}`,
  ];

  if (soldOut) {
    lines.push(displayPrice ? `Status: Sold out — floor ${displayPrice.eth} ${sym}` : 'Status: Sold out — floor price unavailable');
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
  if (collection?.description) lines.push('', collection.description.slice(0, 300));

  const utilityRow = [button('🔄 Refresh', 'flow:detailsrefresh')];
  if (openSeaUrl) utilityRow.push(urlButton('🔗 OpenSea', openSeaUrl));

  return {
    content: lines.join('\n'),
    components: [
      row([button('🪙 Mint Now', 'flow:mintdetailscontinue', 'success')]),
      row(utilityRow),
      row([button('📋 Copy CA', 'flow:copyca')]),
      row([button('❌ Cancel', 'flow:cancel:ask', 'danger')]),
    ],
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
      content: `This contract does not expose a recognized price function. OpenSea suggests a floor price of **${displayPrice.eth} ${sym}**. Use this as the mint price, or enter one yourself?`,
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

// Section AA -- Discord counterpart to Telegram's mintConfirmation.
function mintConfirmation({ contractAddress, chainLabel, walletLabels, quantity = 1, priceETH, priceUnknown }) {
  const priceLine = priceUnknown
    ? 'Price: not exposed by this contract — using the amount you entered above.'
    : `Price: ${priceETH} per item (read from the contract)`;
  return {
    content: `**Confirm mint**\nContract: \`${contractAddress}\`\nChain: ${chainLabel}\nWallet(s): ${walletLabels.join(', ')}\nQuantity: ${quantity} each\n${priceLine}\n\nProceed?`,
    components: [row([button('✅ Confirm', 'flow:mintconfirm', 'success'), button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
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

function walletsMenu() {
  return {
    content: '**Wallets**\nGenerating a new wallet server-side is recommended over importing an existing key.',
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
  return { content: '**Settings**', components: rows };
}

function placeholderMenu(title, hint) {
  return { content: `**${title}**\n${hint}`, components: [row([button('⬅️ Back to menu', 'menu:main')])] };
}

// Discord select-menu options carry a real emoji field (rendered as a small icon beside the
// label, not text) -- unlike command/option names, which the API forbids emoji in entirely.
const CHAIN_EMOJI = { ethereum: '💎', base: '🔵', arbitrum: '🔷', polygon: '🟣', robinhood: '🟢' };

function chainSelect(supportedChains, chains, { customId = 'flow:chain:select' } = {}) {
  const options = supportedChains.map(chain => ({
    label: chains[chain]?.name || chain, value: chain,
    emoji: CHAIN_EMOJI[chain] ? { name: CHAIN_EMOJI[chain] } : undefined,
  }));
  return {
    content: 'Choose a chain:',
    components: [select(customId, options, 'Select a chain'), row([button('❌ Cancel', 'flow:cancel:ask', 'danger')])],
  };
}

function walletSelect(wallets, { customId, emptyHint }) {
  if (!wallets.length) return placeholderMenu('Wallets', emptyHint);
  const options = wallets.map(w => ({ label: `${w.label} (${w.chain})`, value: w.label }));
  return { content: 'Choose a wallet:', components: [select(customId, options, 'Select a wallet'), row([button('⬅️ Back to menu', 'menu:wallets')])] };
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
    content: `**Confirm watch rule**\nName: ${name}\nWatching: ${WATCH_TYPE_META[type]?.label || type}\nMethod: ${WATCH_METHOD_META[method]?.label || method}\n${configLines}\n\nCreate this rule?`,
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
    content: `**${rule.name}**\nStatus: ${rule.enabled ? '🟢 enabled' : '⚪ disabled'}\nWatching: ${WATCH_TYPE_META[rule.type]?.label || rule.type}\nMethod: ${WATCH_METHOD_META[rule.method]?.label || rule.method}\nID: \`${rule.id}\``,
    components: [
      row([button(rule.enabled ? '⏸ Disable' : '▶️ Re-enable', `watch:toggle:${rule.id}`)]),
      row([button('🗑️ Remove', `watch:remove:ask:${rule.id}`, 'danger')]),
      row([button('⬅️ Back to list', 'watch:list')]),
    ],
  };
}

function confirmRemoveWatchRule(rule) {
  return {
    content: `Remove watch rule **${rule.name}**? This cannot be undone.`,
    components: [row([
      button('✅ Yes, remove it', `watch:remove:do:${rule.id}`, 'danger'),
      button('❌ No, keep it', `watch:manage:${rule.id}`),
    ])],
  };
}

function confirmCancelPrompt(flowLabel) {
  return {
    content: `You're in the middle of **${flowLabel}**. Leave it and go back to the menu? Your progress will be cleared.`,
    components: [row([
      button('✅ Yes, cancel and go back', 'flow:cancel:confirm', 'danger'),
      button('↩️ No, keep going', 'flow:cancel:resume', 'secondary'),
    ])],
  };
}

function confirmRemoveWallet(label) {
  return {
    content: `Remove wallet **${label}**? This cannot be undone.`,
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
  button, row, select, mainMenu, walletsMenu, settingsMenu, placeholderMenu,
  chainSelect, walletSelect, confirmCancelPrompt, confirmRemoveWallet, labelModal,
  contractDetailsText, collectionInfoCard, mintQuantitySelect, mintPriceStep, mintConfirmation, numberModal,
  watchTypeSelect, watchMethodSelect, watchConfigModal, watchRuleConfirmation,
  watchRulesList, watchRuleActions, confirmRemoveWatchRule,
};
