const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const { formatEther } = require('ethers');
const { AccountBlockedError, AuthorizationError } = require('../governance/governanceService');
const { formatAdminOverview } = require('../governance/adminOverviewFormat');
const { LinkCodeError } = require('../identity/identityService');
const { ProofResolutionError } = require('../mint/proofResolver');
const { OPENSEA_CHAIN_SLUGS } = require('../mint/openSeaService');
const { TransactionSafetyError } = require('../transactions/transactionEngine');
const { ValidationError, validationReply, LIMITS } = require('../validation/domain');
const { BotContextError, RateLimitError, commandName, createCommandRateLimiter, escapeDiscord,
  verifyDiscordContext } = require('../security/botSecurity');
// Shared with Telegram (src/telegram/flowState.js). That module has no Telegram-specific logic --
// it is a platform-namespaced (platform, chatId) -> flow tracker, written to be reused here.
const { createFlowStateStore } = require('../telegram/flowState');
const discordMenus = require('./menus');
// Section AA: the same platform-agnostic mint_guided decision core Telegram's server.js uses --
// see src/mint/mintFlowDecision.js for why this exists as one shared module instead of a
// hand-mirrored copy per platform.
const mintFlowDecision = require('../mint/mintFlowDecision');
const watchRuleFlowDecision = require('../social/watchRuleFlowDecision');

function json(value, field = 'input') {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new ValidationError({ field, message: 'must be a valid JSON object' }); }
}

function confirmation(interaction) {
  if (interaction.options.getBoolean('confirm') !== true) {
    throw new ValidationError({ field: 'confirm', message: 'must be explicitly enabled for this destructive or value-bearing action' });
  }
}

// Chain/target-type options below are small, fixed sets known at registration time -- Discord
// shows these as a native dropdown instead of a free-text field the user has to type correctly by
// hand, the same way /mode and /social-usage's period already do. chainChoices is built from the
// actual configured supportedChains (not a hardcoded list) so it can never drift from what the
// deployment actually supports; an empty list (no chains/supportedChains passed) degrades to a
// plain free-text field rather than an error, matching this app's usual "missing input degrades,
// never throws" convention.
function commandDefinitions({ supportedChains = [], chains = {} } = {}) {
  const chainChoices = supportedChains.map(chain => ({ name: chains[chain]?.name || chain, value: chain }));
  const chainOption = (o, { required = false, description = 'Supported chain' } = {}) => {
    o.setName('chain').setDescription(description).setRequired(required);
    if (chainChoices.length) o.addChoices(...chainChoices);
    return o;
  };
  const targetTypeOption = o => o.setName('type').setDescription('Target type (sniper or social_rule)').setRequired(true)
    .addChoices({ name: 'Sniper', value: 'sniper' }, { name: 'Social Rule', value: 'social_rule' });
  const commands = [];
  commands.push(new SlashCommandBuilder().setName('menu').setDescription('Open the interactive GhostMint menu'));
  // Telegram counterpart to /start: same welcome text, same first-wallet auto-create, same main
  // menu panel underneath -- a brand-new Discord user had no equivalent first-touch experience at
  // all before this (only /menu, which skips the welcome/auto-create and just shows the bare panel).
  commands.push(new SlashCommandBuilder().setName('start').setDescription('👻 Get started -- auto-creates your first wallet and opens the main menu'));
  commands.push(new SlashCommandBuilder().setName('wallet').setDescription('👛 Manage your wallets')
    .addSubcommand(c => c.setName('create').setDescription('Recommended: generate and securely store a new wallet')
      .addStringOption(o => o.setName('label').setDescription('Unique wallet label').setRequired(true))
      .addStringOption(o => chainOption(o, { required: true })))
    .addSubcommand(c => c.setName('import').setDescription("Import wallet -- not recommended: your key or phrase passes through Discord's messaging systems")
      .addStringOption(o => o.setName('label').setDescription('Unique wallet label').setRequired(true))
      .addStringOption(o => chainOption(o, { required: true }))
      .addStringOption(o => o.setName('private-key').setDescription('Private key or 12/24-word seed phrase; may be exposed in platform transit or client history').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your wallets'))
    .addSubcommand(c => c.setName('balance').setDescription('Check wallet balance across every supported chain')
      .addStringOption(o => o.setName('label').setDescription('Wallet label').setRequired(true).setAutocomplete(true)))
    .addSubcommand(c => c.setName('remove').setDescription('Permanently remove a wallet')
      .addStringOption(o => o.setName('label').setDescription('Wallet label').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm permanent removal').setRequired(true)))
    .addSubcommand(c => c.setName('batch-import').setDescription('Import many private keys at once')
      .addStringOption(o => o.setName('private-keys').setDescription('Comma-separated private keys').setRequired(true))
      .addStringOption(o => chainOption(o, { required: true }))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm batch import of multiple private keys').setRequired(true))
      .addStringOption(o => o.setName('label-prefix').setDescription('Label prefix; wallets are named prefix-1, prefix-2, ...'))));
  commands.push(new SlashCommandBuilder().setName('deposit').setDescription('💰 Get a wallet address to fund')
    .addStringOption(o => o.setName('label').setDescription('Wallet label (optional if you have only one)').setAutocomplete(true)));
  // Only contract is required -- wallet/quantity used to be mandatory too, which meant this could
  // never auto-detect which chain the contract actually lives on (it silently defaulted to the
  // wallet's own home chain instead, and SeaDrop discovery against the wrong chain is exactly what
  // produced the confusing "priceETH could not be determined" error). Omitting wallet or quantity
  // now routes through the same auto-detecting collection card the paste flow already uses (see
  // the 'mint' case below) instead of attempting a one-shot mint with a guessed chain.
  commands.push(new SlashCommandBuilder().setName('mint').setDescription('⚡ Execute a supported mint')
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Wallet label (omit to see the collection card first)').setAutocomplete(true))
    .addIntegerOption(o => o.setName('quantity').setDescription('Quantity (omit to see the collection card first)').setMinValue(1))
    // Not required: price is read from the contract when possible (mintPrice/price/cost/etc.).
    // Only needed if the contract doesn't expose a recognized price getter.
    .addNumberOption(o => o.setName('price').setDescription('Native price per item (only if the contract does not expose one)').setMinValue(0))
    .addStringOption(o => chainOption(o, { description: 'Chain (auto-detected when omitted)' })));
  // Read-only lookup: shows the same collection card as an under-specified /mint, with no
  // mint-intent implied. Mint Now still works from the card if the user decides to go ahead.
  commands.push(new SlashCommandBuilder().setName('info').setDescription('🔍 Look up a contract without minting')
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true)));
  // Mirrors Telegram's /mintnow: typing the command is itself the explicit skip-confirmation
  // opt-in. Immediate, single-wallet, quantity 1 -- no card, no price-entry step, no confirm
  // screen; only asks a question at all if there's more than one wallet to pick from.
  commands.push(new SlashCommandBuilder().setName('mintnow').setDescription('🔥 Mint immediately, no confirmation')
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true)));
  // Only contract is required -- wallets/quantity used to be mandatory free-text too, forcing
  // wallet labels to be typed by hand with no picker at all. Omitting wallets (or quantity) now
  // routes through the same guided card /mint's own under-specified path uses, just with multi:true
  // so the wallet step becomes a real multi-select instead of a single pick.
  commands.push(new SlashCommandBuilder().setName('batch-mint').setDescription('⚡ Mint from multiple wallets')
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true))
    .addStringOption(o => o.setName('wallets').setDescription('Comma-separated wallet labels (omit to pick from a list)'))
    .addIntegerOption(o => o.setName('quantity').setDescription('Quantity per wallet (omit to see the collection card first)').setMinValue(1))
    .addNumberOption(o => o.setName('price').setDescription('Native price per item (only if the contract does not expose one)').setMinValue(0))
    .addStringOption(o => chainOption(o, { description: 'Chain (auto-detected when omitted)' })));
  commands.push(new SlashCommandBuilder().setName('task').setDescription('🗓️ Manage durable scheduled mints')
    .addSubcommand(c => c.setName('create').setDescription('Create a UTC scheduled mint')
      .addStringOption(o => o.setName('input').setDescription('Validated task JSON; mintTime must include Z/offset').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm scheduled value-bearing action').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your scheduled tasks').addIntegerOption(o=>o.setName('page').setDescription('Page number').setMinValue(1)))
    .addSubcommand(c => c.setName('cancel').setDescription('Cancel a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm cancellation').setRequired(true)))
    .addSubcommand(c => c.setName('pause').setDescription('Pause a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)))
    .addSubcommand(c => c.setName('resume').setDescription('Resume a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm resuming value-moving task').setRequired(true)))
    .addSubcommand(c => c.setName('retry').setDescription('Retry a failed task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm retry').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('activity').setDescription('📊 Show your mint activity')
    .addIntegerOption(o=>o.setName('page').setDescription('Page number').setMinValue(1)));
  commands.push(new SlashCommandBuilder().setName('pnl').setDescription('Manage your P&L records')
    .addSubcommand(c => c.setName('list').setDescription('List your P&L records'))
    .addSubcommand(c => c.setName('add').setDescription('Add a P&L record').addStringOption(o => o.setName('input').setDescription('Record JSON').setRequired(true)))
    .addSubcommand(c => c.setName('delete').setDescription('Delete a P&L record').addStringOption(o => o.setName('id').setDescription('Record UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm deletion').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('gas').setDescription('⛽ Show live chain fee data')
    .addStringOption(o => chainOption(o)));
  commands.push(new SlashCommandBuilder().setName('sniper').setDescription('🎯 Manage post-confirmation copy snipers (not mempool front-running)')
    .addSubcommand(c => c.setName('create').setDescription('Create post-confirmation copy sniper').addStringOption(o => o.setName('input').setDescription('Validated sniper JSON').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm automated copy configuration').setRequired(true)))
    .addSubcommand(c => c.setName('update').setDescription('Update post-confirmation copy sniper').addStringOption(o => o.setName('id').setDescription('Sniper UUID').setRequired(true)).addStringOption(o => o.setName('patch').setDescription('Validated patch JSON').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm automated copy configuration change').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List post-confirmation copy snipers'))
    .addSubcommand(c => c.setName('status').setDescription('Show a post-confirmation copy sniper').addStringOption(o => o.setName('id').setDescription('Sniper UUID').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('mode').setDescription('🎛️ Select your transaction mode preset')
    .addStringOption(o => o.setName('preset').setDescription('Preset').setRequired(true).addChoices(
      { name: '🔥 Degen -- fastest, high gas, no confirmation', value: 'ultra_fast' },
      { name: '⚡ Fast -- quick, higher gas, still confirms', value: 'fast' },
      { name: '🐢 Cautious -- careful, moderate gas', value: 'semi_safe' },
      { name: '🛡️ Normie -- slowest, safest, network-price gas', value: 'safe' },
    ))
    .addBooleanOption(o=>o.setName('confirm').setDescription('Confirm transaction-mode change').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('admin').setDescription('🛡️ Owner-only governance command')
    .addStringOption(o => o.setName('action').setDescription('Governance action and arguments').setRequired(true))
    .addBooleanOption(o=>o.setName('confirm').setDescription('Confirm owner-level action').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('link').setDescription('🔗 Consume a cross-platform account link code generated on Telegram')
    .addStringOption(o => o.setName('code').setDescription('Single-use code generated by /link on your Telegram account').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('watch').setDescription('📡 Manage social contract-address watch rules')
    .addSubcommand(c => c.setName('add').setDescription('Add a social watch rule').addStringOption(o => o.setName('input').setDescription('Watch rule JSON').setRequired(true)))
    .addSubcommand(c => c.setName('edit').setDescription('Edit a rule or switch its adapter method').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)).addStringOption(o => o.setName('patch').setDescription('Watch rule patch JSON').setRequired(true)))
    .addSubcommand(c => c.setName('disable').setDescription('Disable a social watch rule').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)))
    .addSubcommand(c => c.setName('remove').setDescription('Remove a social watch rule').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm permanent removal').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your social watch rules')));
  commands.push(new SlashCommandBuilder().setName('social-usage').setDescription('Owner-only: social API usage and estimated cost')
    .addStringOption(o => o.setName('period').setDescription('Reporting period').addChoices(
      { name:'📅 Today', value:'today' }, { name:'📆 This month', value:'month' })));
  commands.push(new SlashCommandBuilder().setName('target-policy').setDescription('Configure per-target trigger and verification behavior')
    .addSubcommand(c=>c.setName('set').setDescription('Set target policy from JSON').addStringOption(o=>o.setName('input').setDescription('Target policy JSON').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm trigger policy change').setRequired(true)))
    .addSubcommand(c=>c.setName('show').setDescription('Show target policy').addStringOption(o=>targetTypeOption(o)).addStringOption(o=>o.setName('id').setDescription('Target UUID').setRequired(true)))
    .addSubcommand(c=>c.setName('bypass').setDescription('Request highest-risk social verification bypass').addStringOption(o=>targetTypeOption(o)).addStringOption(o=>o.setName('id').setDescription('Target UUID').setRequired(true)).addBooleanOption(o=>o.setName('dont-ask-again').setDescription('Skip future warnings for this target only')))
    .addSubcommand(c=>c.setName('confirm-bypass').setDescription('Explicitly confirm bypass warning').addStringOption(o=>o.setName('challenge').setDescription('Challenge UUID').setRequired(true)).addStringOption(o=>o.setName('confirmation').setDescription('Must be CONFIRM').setRequired(true)))
    .addSubcommand(c=>c.setName('preset').setDescription('Apply a mode preset starting point').addStringOption(o=>o.setName('input').setDescription('Target and preset JSON').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm target preset change').setRequired(true)))
    .addSubcommand(c=>c.setName('reset').setDescription('Reset target policy and bypass acknowledgement').addStringOption(o=>targetTypeOption(o)).addStringOption(o=>o.setName('id').setDescription('Target UUID').setRequired(true)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm policy reset').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('confirm-trigger').setDescription('Approve or reject a pending triggered mint')
    .addStringOption(o=>o.setName('request').setDescription('Confirmation request UUID').setRequired(true))
    .addStringOption(o=>o.setName('confirmation').setDescription('Must be CONFIRM or REJECT').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('trigger-audit').setDescription('Show trigger execution audit records'));
  commands.push(new SlashCommandBuilder().setName('pending').setDescription('View pending transactions and confirmations'));
  commands.push(new SlashCommandBuilder().setName('transactions').setDescription('List your transaction history')
    .addIntegerOption(o=>o.setName('page').setDescription('Page number').setMinValue(1)));
  return commands.map(command => command.toJSON());
}

function formatRows(rows, empty, mapper) {
  return rows.length ? rows.map(mapper).join('\n') : empty;
}

// ── Discord guided-menu UX (Milestone 15c) ──────────────
// Mirrors the Telegram Milestone 15a/15b UX (persistent menu + guided multi-step flows with
// cancel confirmation) using Discord message components (buttons, select menus, modals) instead
// of Telegram's inline keyboard + plain-text replies. Every guided step still ends by calling the
// exact same botCommandService function the equivalent slash command already used above -- this
// changes presentation only, never validation, transaction submission, or governance.
const FLOW_LABELS = { wallet_create: 'creating a wallet', wallet_import: 'importing a wallet',
  wallet_batch_import: 'importing several wallets', mint_guided: 'minting', task_guided: 'scheduling a mint', watch_guided: 'adding a watch rule' };
const FLOW_CONTINUATIONS = {
  wallet_create: ['flow:label:submit', 'flow:chain:select'],
  wallet_import: ['flow:label:submit', 'flow:chain:select', 'wallet:import:key-modal', 'flow:key:submit'],
  // Keys accumulate across repeated taps of the SAME two ids, so this list stays fixed however
  // many are added -- no dynamic custom_ids, the rule every other flow here follows.
  wallet_batch_import: ['flow:chain:select', 'wallet:batch-import:add', 'flow:batchkeys:submit', 'wallet:batch-import:confirm'],
  // Section AA -- every custom_id stays fixed (select-menu VALUES carry the chosen quantity/
  // wallet, never the custom_id itself), so this list needs no dynamic/prefix matching.
  mint_guided: ['flow:mintdetailscontinue', 'flow:detailsrefresh', 'flow:copyca', 'flow:schedulesuggest', 'flow:mintqty:select', 'flow:mintqty:submit', 'flow:mintwallet:select', 'flow:mintwalletmulti:select', 'flow:priceaccept', 'flow:pricemanual', 'flow:mintprice:submit', 'flow:gastoleranceaccept', 'flow:gastolerancemanual', 'flow:gastolerance:submit', 'flow:mintconfirm'],
  // Section AF follow-up: Discord's mini schedule flow (Section S's full guided flow remains
  // unbuilt) -- a fixed chain, optional quantity select/modal (only when maxPerWallet > 1) ->
  // wallet select -> name select -> optional custom-name modal -> confirm, with no dynamic values
  // in any of its own custom_ids. Shares flow:mintqty:select/submit with mint_guided -- the
  // quantity picker is the same component either way (see mintFlowRenderPayload's counterpart in
  // discordBot.js), and the callback handler branches on flow.flow.
  task_guided: ['flow:taskwallet:select', 'flow:mintqty:select', 'flow:mintqty:submit', 'flow:taskname:select', 'flow:taskname:submit', 'flow:taskconfirm'],
  watch_guided: ['flow:watchname:submit', 'flow:watchtype:select', 'flow:watchmethod:select', 'flow:watchconfig:submit', 'flow:watchconfirm'],
};

function renderFlowStep(flow, step, { supportedChains = [], chains = {} } = {}) {
  if (flow === 'wallet_batch_import' && step === 'awaiting_chain') {
    return discordMenus.chainSelect(supportedChains, chains);
  }
  if ((flow === 'wallet_create' || flow === 'wallet_import') && step === 'awaiting_chain') {
    return discordMenus.chainSelect(supportedChains, chains);
  }
  if (flow === 'wallet_import' && step === 'awaiting_key') {
    return {
      content: "⚠️ Not recommended: your private key or recovery phrase passes through Discord's messaging systems and may remain in client history or notification previews. Tap below to enter it, or cancel.",
      components: [discordMenus.row([
        discordMenus.button('🔑 Enter key or phrase', 'wallet:import:key-modal', 'danger'),
        discordMenus.button('❌ Cancel', 'flow:cancel:ask', 'secondary'),
      ])],
    };
  }
  return discordMenus.mainMenu({});
}

function retryStepForField(error) {
  const field = error.issues?.[0]?.field;
  if (field === 'label') return 'awaiting_label';
  if (field === 'privateKey' || field === 'seedPhrase') return 'awaiting_key';
  if (field === 'chain') return 'awaiting_chain';
  return null;
}

function componentErrorMessage(error) {
  if (error instanceof ValidationError) return escapeDiscord(validationReply(error));
  if (error instanceof AccountBlockedError) return escapeDiscord(`⛔ Your account is ${error.status}${error.reason ? `: ${error.reason}` : ''}. Contact the project owner if you believe this is a mistake.`);
  if (error instanceof AuthorizationError) return 'Owner access required.';
  if (error instanceof RateLimitError) return `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`;
  if (error instanceof BotContextError) return 'Command rejected: this bot is not enabled here. Use an allowed channel, or DM it directly.';
  if (error instanceof LinkCodeError || error instanceof ProofResolutionError || error instanceof TransactionSafetyError) return escapeDiscord(error.message);
  return 'Action failed safely. Please try again.';
}

function dcRespond(interaction, payload) {
  // A component interaction that already deferred (interaction.deferUpdate(), used by a handler
  // doing slow work -- an RPC balance check, a live contract re-detection -- before it has anything
  // to show) can no longer be answered via update()/reply(): Discord already considers it
  // acknowledged, and calling either again throws "already acknowledged". editReply() is the only
  // valid follow-up once deferred, for a deferred reply or a deferred update alike.
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  if (typeof interaction.update === 'function') {
    return interaction.update(payload).catch(() => (typeof interaction.reply === 'function' ? interaction.reply({ ...payload, ephemeral: true }).catch(() => {}) : undefined));
  }
  if (typeof interaction.reply === 'function') return interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  return Promise.resolve();
}

// ── Section AA: Discord guided mint flow ──────────────
// Pasting a bare contract address or an OpenSea link (Section Q) starts this the same way
// Telegram's mint_guided does, sharing its decision core (src/mint/mintFlowDecision.js) so the
// two platforms can't silently diverge. Every step still ends by calling the exact same
// botCommandService function the slash command uses.
//
// The one real platform difference: the opening message comes from a plain channel reply
// (message.reply can't be ephemeral, unlike every other Discord reply in this bot), so it's
// visible to the whole channel until the owning user's first interaction. From that first
// interaction on, every further step -- wallet labels, prices, the final mint result -- goes
// ephemeral, and the now-stale public message has its buttons stripped so nobody else can act on
// it. flowState is already keyed per clicking user (context.platformUserId), so a non-owner's
// click never sees or advances someone else's flow; it just gets told to start their own.
function mintFlowRenderPayload(step, data, { wallets = [], chains = {} } = {}) {
  // Section AD Tier 1: the flow's real first screen -- market cap, volume, floor, holders
  // alongside the existing mint-specific fields, with Mint Now as one of several actions
  // (Refresh, Copy CA, View on OpenSea) rather than a dead "tap to continue" pass-through.
  // Supersedes Section AA's withDetailsHeader merge the same way Section M's merge was
  // superseded on Telegram.
  if (step === 'awaiting_details') {
    return discordMenus.collectionInfoCard({
      contractAddress: data.contractAddress, chain: data.chain, chainLabel: chains[data.chain]?.name || data.chain,
      chainSym: chains[data.chain]?.sym, isSeaDrop: data.isSeaDrop, priceETH: data.priceETH, priceUnknown: data.priceUnknown,
      maxSupply: data.maxSupply, maxPerWallet: data.maxPerWallet, startTime: data.startTime,
      collection: data.collection, soldOut: data.soldOut, displayPrice: data.displayPrice,
      stats: data.stats, openSeaUrl: data.openSeaUrl,
    });
  }
  if (step === 'awaiting_quantity') return discordMenus.mintQuantitySelect(data);
  if (step === 'awaiting_wallet') {
    return data.multi
      ? discordMenus.walletMultiSelect(wallets, { customId: 'flow:mintwalletmulti:select', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' })
      : discordMenus.walletSelect(wallets, { customId: 'flow:mintwallet:select', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' });
  }
  if (step === 'awaiting_price') return discordMenus.mintPriceStep({ chainSym: chains[data.chain]?.sym, displayPrice: data.displayPrice });
  // /batch-mint only (see mintFlowDecision.afterPriceKnown) -- currentGasGwei/gasCeilingGwei are
  // resolved live just before this step is rendered (applyMintFlowStep's withGasToleranceContext
  // below), the same "fetch before rendering" pattern Telegram's own gas-tolerance step already
  // uses in server.js.
  if (step === 'awaiting_gastolerance') return discordMenus.gasTolerancePrompt({ currentGasGwei: data.currentGasGwei, ceilingGwei: data.gasCeilingGwei });
  if (step === 'awaiting_confirm') {
    return discordMenus.mintConfirmation({
      contractAddress: data.contractAddress, chainLabel: chains[data.chain]?.name || data.chain,
      walletLabels: data.selectedWallets, quantity: data.quantity || 1, priceETH: data.priceETH, priceUnknown: data.priceUnknown,
      maxGasGwei: data.maxGasGwei,
    });
  }
  return undefined;
}

// Best-effort: strips the public opening message's components the moment the owning user's first
// interaction against this flow happens (button/select click, or opening a custom-amount modal),
// so a later click by someone else in the channel has nothing left to act on. Never blocks the
// real response on this succeeding -- flow ownership is already enforced by flowState being keyed
// to the clicking user's own id regardless of whether this edit lands.
function neutralizeMintOriginMessage(interaction) {
  interaction.message?.edit?.({ content: '↩️ Continuing below — only visible to you.', components: [] }).catch(() => {});
}

// Applies a decision from mintFlowDecision.js: persists the resulting step and renders it, or
// executes outright when the decision was 'execute'. `respond` is supplied by the caller (a plain
// message reply for the flow's opening screen, an interaction reply/update for every step after)
// so this stays delivery-agnostic. `ctx` bundles the handful of dependencies both createDiscordBot
// (the messageCreate trigger) and createDiscordInteractionHandler (every later step) already have.
// /batch-mint only -- resolved live just before the gas-tolerance step is rendered, mirroring
// Telegram's withGasToleranceContext in server.js exactly (live network gas price alongside the
// account's own effective ceiling, never the other way around).
async function withGasToleranceContext(commands, userId, data) {
  const [fees, gasCeilingGwei] = await Promise.all([
    commands.gas(data.chain).catch(() => null),
    commands.gasCeiling(userId, data.chain),
  ]);
  return { ...data, currentGasGwei: fees?.gasPriceGwei ?? null, gasCeilingGwei };
}

async function applyMintFlowStep(ctx, respond, platformUserId, userId, { step, data }) {
  const { commands, flowState, chains } = ctx;
  if (step === 'execute') return finishMintExecutionDiscord(ctx, respond, platformUserId, userId, data);
  const wallets = step === 'awaiting_wallet' ? commands.wallets(userId) : [];
  const renderData = step === 'awaiting_gastolerance' ? await withGasToleranceContext(commands, userId, data) : data;
  flowState.advance('discord', platformUserId, step, renderData);
  return respond(mintFlowRenderPayload(step, renderData, { wallets, chains }));
}

// Mirrors server.js's finishMintExecution exactly: a rate limit leaves the flow intact (so the
// user can just retry once it clears) instead of discarding their in-progress mint; every other
// outcome, success or failure, clears it.
async function finishMintExecutionDiscord(ctx, respond, platformUserId, userId, flowData) {
  const { commands, flowState, rateLimiter } = ctx;
  const backToMenu = [discordMenus.row([discordMenus.button('⬅️ Back to menu', 'menu:main')])];
  try {
    rateLimiter.check('discord', userId, flowData.multi ? 'batch-mint' : 'mint');
    if (flowData.multi) {
      const results = await commands.batchMint(userId, { walletLabels: flowData.selectedWallets,
        contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: flowData.quantity || 1, priceETH: flowData.priceETH, maxGasGwei: flowData.maxGasGwei });
      flowState.clear('discord', platformUserId);
      // Per wallet: batchMint no longer aborts on the first failure, so a bare count would
      // report a batch where half the wallets never minted as an unqualified success.
      const ok = results.filter(item => item.state !== 'failed');
      const lines = results.map(item => (item.state === 'failed'
        ? `❌ **${escapeDiscord(String(item.walletLabel))}** — ${escapeDiscord(String(item.error || 'failed'))}`
        : `✅ **${escapeDiscord(String(item.walletLabel))}** — ${escapeDiscord(String(item.state || 'submitted'))}`
          + (item.txHash ? ` \`${item.txHash}\`` : '')));
      return respond({ content: `**Batch mint — ${ok.length} of ${results.length} submitted**\n${lines.join('\n')}`, components: backToMenu });
    }
    const result = await commands.mint(userId, { walletLabel: flowData.selectedWallets[0],
      contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: flowData.quantity || 1, priceETH: flowData.priceETH });
    flowState.clear('discord', platformUserId);
    return respond({ content: `✅ Mint ${result.state}: \`${escapeDiscord(String(result.txHash || result.intentId))}\``, components: backToMenu });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return respond({ content: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, components: backToMenu });
    }
    flowState.clear('discord', platformUserId);
    if (error instanceof ValidationError) return respond({ content: escapeDiscord(validationReply(error)), components: backToMenu });
    if (error instanceof TransactionSafetyError) return respond({ content: `❌ ${escapeDiscord(error.message)}`, components: backToMenu });
    throw error;
  }
}

// Reached once a quantity is settled (chosen via the select, typed in the custom-amount modal, or
// defaulted to 1 when maxPerWallet doesn't allow more) -- task_guided has no batch/multi concept
// and no public origin message to neutralize (unlike mint_guided's paste trigger), so this only
// ever needs to decide between auto-selecting the sole wallet and showing a picker, mirroring
// Telegram's advanceFromTaskQuantity.
function advanceFromTaskQuantity(ctx, respond, platformUserId, userId, taskData) {
  const { commands, flowState } = ctx;
  const wallets = commands.wallets(userId);
  if (wallets.length === 1) {
    flowState.start('discord', platformUserId, 'task_guided', 'awaiting_name', { ...taskData, walletLabel: wallets[0].label });
    return respond(discordMenus.taskNameQuickPicks());
  }
  flowState.start('discord', platformUserId, 'task_guided', 'awaiting_wallet', taskData);
  return respond(discordMenus.walletSelect(wallets, { customId: 'flow:taskwallet:select', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' }));
}

// Section AF follow-up -- Discord's mini schedule flow. Mirrors finishMintExecutionDiscord's rate-
// limit handling: a rate limit leaves the flow intact so the user can just retry once it clears,
// every other outcome (success or failure) clears it.
async function finishTaskScheduleDiscord(ctx, respond, platformUserId, userId, flowData) {
  const { commands, flowState, rateLimiter } = ctx;
  const backToMenu = [discordMenus.row([discordMenus.button('⬅️ Back to menu', 'menu:main')])];
  try {
    rateLimiter.check('discord', userId, 'task');
    const task = await commands.createTask(userId, {
      name: flowData.name, walletLabel: flowData.walletLabel, contractAddress: flowData.contractAddress,
      chain: flowData.chain, quantity: flowData.quantity || 1, priceETH: flowData.priceETH, mintTime: flowData.mintTime,
    });
    flowState.clear('discord', platformUserId);
    return respond({ content: `✅ Scheduled ${escapeDiscord(task.name)} to fire at \`${discordMenus.formatGmtPlus1(task.mintTime)}\`.`, components: backToMenu });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return respond({ content: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, components: backToMenu });
    }
    flowState.clear('discord', platformUserId);
    if (error instanceof ValidationError) return respond({ content: escapeDiscord(validationReply(error)), components: backToMenu });
    throw error;
  }
}

// Entry point for a bare address/link paste (Section Q's resolution) with no active flow. Section
// AD Tier 1: shows the rich collection info card as the flow's real first screen (market cap,
// volume, floor, holders), with Mint Now as one of its actions -- that's what actually triggers
// the shared decision core (mintFlowDecision.afterDetails) advanceFromDetails-equivalent logic
// below reuses. skipConfirm is always false here -- Telegram's own bare-paste trigger never
// bypasses confirmation either; that's /mintnow-specific and out of scope for a plain paste on
// either platform.
// originMessagePublic defaults to true (the paste-detection trigger: a public message.reply that
// needs neutralizing on the owner's first touch) but is false for /mint's own under-specified-args
// path below, whose response is already ephemeral from interaction.deferReply -- there is no
// public origin message to neutralize, and treating it as one would try to reply a second time to
// an interaction that already replied.
// includeStats defaults to false -- the full OpenSea floor/holders/volume table is reserved for
// /info's explicit, no-mint-intent lookup; a plain paste and /mint's own under-specified path get
// the leaner card (still real live price/timing/sold-out status, just without the stats table).
// Carried into flow data so flow:detailsrefresh knows whether to keep re-requesting stats on this
// same flow or stay lean, without needing to know which entry point originally started it.
async function startMintGuidedFlow(ctx, respond, platformUserId, userId, contractAddressInput, { originMessagePublic = true, includeStats = false, multi = false } = {}) {
  const { commands, flowState, chains } = ctx;
  const contractAddress = await commands.resolveMintContractInput(contractAddressInput);
  if (!contractAddress) return undefined;
  let detected;
  try {
    detected = await commands.detectMintContract(userId, { contractAddress, quantity: 1, includeStats });
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
  const data = {
    multi, contractAddress, chain: detected.chain, selectedWallets: [],
    isSeaDrop: detected.isSeaDrop,
    priceETH: detected.priceKnown ? Number(formatEther(BigInt(detected.valueWei))) : undefined,
    priceUnknown: !detected.priceKnown,
    maxSupply: detected.maxSupply, maxPerWallet: detected.maxPerWallet,
    startTime: detected.startTime, endTime: detected.endTime, collection: detected.collection,
    soldOut: detected.soldOut, displayPrice: detected.displayPrice,
    stats: detected.stats, includeStats,
    openSeaUrl: OPENSEA_CHAIN_SLUGS[detected.chain] ? `https://opensea.io/assets/${OPENSEA_CHAIN_SLUGS[detected.chain]}/${contractAddress}` : null,
    skipConfirm: false,
    originMessagePublic,
  };
  flowState.start('discord', platformUserId, 'mint_guided', 'awaiting_details', data);
  return respond(mintFlowRenderPayload('awaiting_details', data, { chains }));
}

// Entry point for /mintnow: skips the details card, quantity step, price-entry step, and confirm
// screen entirely -- typing the command is itself the explicit skip-confirmation opt-in, mirroring
// Telegram's oneShot. Quantity is always 1 (mintnow is a single quick mint, not a batch/quantity-
// picking flow -- /mint's guided card is there for more control). If the contract exposes a real
// price it's used; if not, priceETH is left at 0 and priceUnknown is forced to false so the shared
// decision core (mintFlowDecision.afterWalletSelection/afterPriceKnown) goes straight to execution
// instead of asking. This isn't really "guessing" for the common SeaDrop case: prepareMintCall
// already re-reads the live on-chain price at execution time regardless of what's passed here. For
// a plain contract with no price getter at all, this sends 0 and lets the contract's own revert
// (surfaced through the existing simulation/error decoding) be the honest answer if that's wrong,
// rather than blocking on a price nobody -- user or contract -- can actually supply up front.
async function startMintNowFlow(ctx, respond, platformUserId, userId, contractAddressInput) {
  const { commands, flowState, chains } = ctx;
  const contractAddress = await commands.resolveMintContractInput(contractAddressInput);
  if (!contractAddress) return undefined;
  let detected;
  try {
    detected = await commands.detectMintContract(userId, { contractAddress, quantity: 1 });
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
  const data = {
    multi: false, contractAddress, chain: detected.chain, selectedWallets: [],
    isSeaDrop: detected.isSeaDrop,
    priceETH: detected.priceKnown ? Number(formatEther(BigInt(detected.valueWei))) : 0,
    priceUnknown: false, quantity: 1, skipConfirm: true, originMessagePublic: false,
  };
  const wallets = commands.wallets(userId);
  if (wallets.length === 1) {
    return finishMintExecutionDiscord(ctx, respond, platformUserId, userId, { ...data, selectedWallets: [wallets[0].label] });
  }
  flowState.start('discord', platformUserId, 'mint_guided', 'awaiting_wallet', data);
  return respond(discordMenus.walletSelect(wallets, { customId: 'flow:mintwallet:select', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' }));
}

function createDiscordInteractionHandler({ identity, commands, allowedGuildId, allowedChannelIds=null, securityAudit={record:async()=>{}},
  rateLimiter=createCommandRateLimiter(), log = () => {}, isOwner, checkAccountStatus, supportedChains=[], chains={},
  flowState=createFlowStateStore() }) {
  const audit=value=>Promise.resolve(securityAudit.record(value)).catch(error=>log(`Security audit write failed: ${error.message}`));
  const ownerFlag = async userId => (typeof isOwner === 'function' ? Boolean(await isOwner(userId)) : false);
  const enforceAccountStatus = async userId => { if (typeof checkAccountStatus === 'function') await checkAccountStatus(userId); };
  // Section AA: shared bundle applyMintFlowStep/finishMintExecutionDiscord/startMintGuidedFlow
  // need, so every call site below passes the same four dependencies instead of re-listing them.
  const mintCtx = { commands, flowState, chains, rateLimiter };
  // Deferred (or already-replied) is the common case now that handleComponent defers up front --
  // followUp() posts a fresh ephemeral message without needing a prior reply(). The one exception
  // is a modal-reserved tap (see willShowModal) that turns out to be stale/not-mine: no ack ever
  // happened for it, so this has to fall back to a genuine first reply() instead.
  const notYourMintPrompt = interaction => (interaction.deferred || interaction.replied
    ? interaction.followUp({ content: "This isn't your mint prompt. Paste your own address or link to start one.", ephemeral: true })
    : interaction.reply({ content: "This isn't your mint prompt. Paste your own address or link to start one.", ephemeral: true })
  ).catch(() => {});

  // Every custom_id that opens a modal, determined synchronously from data (and, for the two
  // conditional ones, the already-available interaction.values) -- showModal() is mutually
  // exclusive with defer/reply, so handleComponent's blanket up-front defer below must skip these
  // or every one of them would throw "already acknowledged" the moment it tried to open its modal.
  const MODAL_CUSTOM_IDS = new Set(['menu:mint:single', 'menu:mint:batch', 'link:enter', 'wallet:create:start', 'wallet:import:start', 'wallet:import:key-modal', 'flow:pricemanual', 'flow:gastolerancemanual', 'watch:add:start', 'flow:watchmethod:select']);
  function willShowModal(data, interaction) {
    if (MODAL_CUSTOM_IDS.has(data)) return true;
    if (data === 'flow:mintqty:select' && interaction.values?.[0] === 'custom') return true;
    if (data === 'flow:taskname:select' && interaction.values?.[0] === 'custom') return true;
    return false;
  }

  async function handleComponent(interaction) {
    let context, userId = null;
    const data = interaction.customId || '';
    try {
      context = verifyDiscordContext(interaction, allowedGuildId, { allowedChannelIds });
      // Acknowledge before any DB/RPC work at all -- Discord gives only 3s to acknowledge a
      // component interaction, and identity resolution (a DB round trip) alone can eat into that
      // on a slow connection, before any handler-specific work even begins ("didn't respond in
      // time" was being seen even on menu:wallets, which does no slow work of its own). Every
      // handler below already goes through dcRespond (defer-aware: routes to editReply once
      // deferred) or its own followUp() for the public-origin-message-to-ephemeral transition, so
      // deferring unconditionally here is safe for everything except the modal-opening exceptions.
      if (!willShowModal(data, interaction)) await interaction.deferUpdate();
      userId = await identity.resolveOrCreate('discord', context.platformUserId);
      await enforceAccountStatus(userId);
      const platformUserId = context.platformUserId;

      // A tap that doesn't belong to whatever flow is currently active implicitly abandons it and
      // proceeds with the new action -- no confirmation needed, trimmed per user feedback. The
      // explicit Cancel button (flow:cancel:ask) is handled the same way: straight to the main
      // menu, no "are you sure" step first.
      const activeFlow = flowState.get('discord', platformUserId);
      if (activeFlow && data !== 'flow:cancel:ask' && !(FLOW_CONTINUATIONS[activeFlow.flow] || []).includes(data)) {
        flowState.clear('discord', platformUserId);
      }
      if (data === 'flow:cancel:ask') {
        flowState.clear('discord', platformUserId);
        return dcRespond(interaction, discordMenus.mainMenu({ isOwner: await ownerFlag(userId) }));
      }

      if (data === 'menu:main') return dcRespond(interaction, discordMenus.mainMenu({ isOwner: await ownerFlag(userId) }));
      if (data === 'menu:wallets') return dcRespond(interaction, discordMenus.walletsMenu());
      if (data === 'menu:settings') return dcRespond(interaction, discordMenus.settingsMenu({ isOwner: await ownerFlag(userId) }));
      // Section O -- the one genuinely free-text field a mint needs (a contract address) has
      // nothing to pick from a list, so this opens a modal rather than a select/button, same as
      // every other unavoidably-free-text field elsewhere in this file (wallet labels, private
      // keys). Submitting routes through startMintGuidedFlow below -- the exact same auto-detecting
      // card /mint's own under-specified path and a bare paste already use, not a separate path.
      if (data === 'menu:mint') return dcRespond(interaction, discordMenus.mintModeMenu());
      if (data === 'menu:mint:single') return interaction.showModal(discordMenus.labelModal({ customId: 'menu:mint:submit', title: 'Contract address to mint', maxLength: 200 }));
      if (data === 'menu:mint:batch') return interaction.showModal(discordMenus.labelModal({ customId: 'menu:mint:batch:submit', title: 'Contract address to batch mint', maxLength: 200 }));
      if (data === 'menu:tasks') {
        const page = await commands.tasksPage(userId, { page: 1 });
        return dcRespond(interaction, discordMenus.tasksMenu(page));
      }
      if (data.startsWith('tasks:page:')) {
        const page = await commands.tasksPage(userId, { page: Number(data.slice('tasks:page:'.length)) || 1 });
        return dcRespond(interaction, discordMenus.tasksMenu(page));
      }
      if (data === 'menu:snipers') return dcRespond(interaction, discordMenus.snipersMenu(commands.snipers(userId)));
      // menu:watch is handled further below, alongside the rest of the watch-rule guided flow.
      if (data === 'menu:activity') {
        const page = await commands.activityPage(userId, { page: 1 });
        return dcRespond(interaction, discordMenus.activityMenu(page));
      }
      if (data.startsWith('activity:page:')) {
        const page = await commands.activityPage(userId, { page: Number(data.slice('activity:page:'.length)) || 1 });
        return dcRespond(interaction, discordMenus.activityMenu(page));
      }
      if (data === 'menu:gas' || data.startsWith('gas:chain:')) {
        const gasChain = data.startsWith('gas:chain:') ? data.slice('gas:chain:'.length) : 'ethereum';
        const fees = await commands.gas(gasChain).catch(() => null);
        return dcRespond(interaction, discordMenus.gasMenu({ chain: gasChain, fees, supportedChains, chains }));
      }
      if (data === 'menu:admin') {
        const overview = await commands.adminOverview(userId);
        return dcRespond(interaction, discordMenus.adminOverviewMenu(formatAdminOverview(overview)));
      }

      if (data === 'link:enter') {
        return interaction.showModal(discordMenus.labelModal({ customId: 'link:code:submit', title: 'Link code from Telegram' }));
      }

      if (data === 'wallet:list') {
        const wallets = commands.wallets(userId);
        if (!wallets.length) return dcRespond(interaction, discordMenus.placeholderMenu('Wallets', 'No wallets yet. Go back and tap Create wallet.'));
        // Escape only the USER-CONTROLLED parts. Escaping the finished string escaped the very
        // markdown this message is built from -- the code-fence backticks became literal, and every
        // . - ( ) picked up a backslash, so the list rendered as a wall of slashes rather than as
        // wallets. A label is the only thing a user controls, so it is the only thing to escape.
        const list = wallets.map((w, i) => {
          const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
          const chain = chains[w.chain]?.name || w.chain;
          return `${i + 1}. **${escapeDiscord(w.label)}** \`${short}\` · ${escapeDiscord(chain)} · minted: ${w.minted || 0}`;
        }).join('\n');
        return dcRespond(interaction, { content: `**Wallets (${wallets.length})**\n${list}`,
          components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
      }

      if (data === 'wallet:create:start') {
        flowState.start('discord', platformUserId, 'wallet_create', 'awaiting_label');
        return interaction.showModal(discordMenus.labelModal({ customId: 'flow:label:submit', title: 'New wallet label' }));
      }
      if (data === 'wallet:batch-import:start') {
        // No chain step -- see the Telegram counterpart and detectHomeChain().
        flowState.start('discord', platformUserId, 'wallet_batch_import', 'awaiting_key', { privateKeys: [] });
        return dcRespond(interaction, discordMenus.batchImportMenu({ count: 0 }));
      }
      if (data === 'wallet:import:start') {
        flowState.start('discord', platformUserId, 'wallet_import', 'awaiting_label');
        return interaction.showModal(discordMenus.labelModal({ customId: 'flow:label:submit', title: 'Wallet label to import' }));
      }
      if (data === 'wallet:import:key-modal') {
        return interaction.showModal(discordMenus.labelModal({ customId: 'flow:key:submit', title: 'Private key or seed phrase', maxLength: 256 }));
      }

      if (data === 'wallet:batch-import:add') {
        return interaction.showModal(discordMenus.labelModal({ customId: 'flow:batchkeys:submit',
          title: 'Private keys (not recommended)', style: 'paragraph', maxLength: 4000,
          placeholder: 'One key per line' }));
      }
      if (data === 'wallet:batch-import:confirm') {
        // Read the flow here rather than relying on the outer scope: this branch runs in the
        // button dispatcher, above where flow:chain:select fetches its own copy.
        const flow = flowState.get('discord', platformUserId);
        const collected = flow?.data?.privateKeys || [];
        if (!collected.length) return dcRespond(interaction, discordMenus.batchImportMenu({ count: 0 }));
        rateLimiter.check('discord', userId, 'batch-import');
        const results = await commands.importWalletsBatch(userId, {
          privateKeys: collected, chain: flow.data.chain, labelPrefix: flow.data.labelPrefix });
        flowState.clear('discord', platformUserId);
        const ok = results.filter(item => item.status === 'success');
        // Per key, because partial success is the normal outcome: one bad key must not discard the
        // rest, and a single verdict would hide which ones actually landed.
        const lines = results.map(item => item.status === 'success'
          ? `✅ ${escapeDiscord(item.label)} \`${item.address}\` · ${escapeDiscord(chains[item.chain]?.name || item.chain || '')}${item.detected ? ' (detected)' : ''}`
          : `❌ #${item.index + 1} — ${escapeDiscord(String(item.error || 'failed'))}`);
        return dcRespond(interaction, {
          content: `**Batch import — ${ok.length} of ${results.length} imported**\n${lines.join('\n')}`,
          components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
      }
      if (data === 'flow:chain:select') {
        const chain = interaction.values?.[0];
        const flow = flowState.get('discord', platformUserId);
        if (!flow) return dcRespond(interaction, discordMenus.mainMenu({ isOwner: await ownerFlag(userId) }));
        if (flow.flow === 'wallet_batch_import') {
          flowState.advance('discord', platformUserId, 'awaiting_key', { chain, privateKeys: [] });
          return dcRespond(interaction, discordMenus.batchImportMenu({ count: 0, chainLabel: chains[chain]?.name || chain }));
        }
        if (flow.flow === 'wallet_create') {
          try {
            const wallet = await commands.createWallet(userId, { label: flow.data.label, chain });
            flowState.clear('discord', platformUserId);
            return dcRespond(interaction, { content: `✅ Wallet ${wallet.label} generated securely.\nAddress: \`${wallet.address}\`\nChain: ${wallet.chain}\n\nFund this address to use it. The private key was encrypted at creation and never leaves the server.`,
              components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
          } catch (error) {
            flowState.clear('discord', platformUserId);
            if (error instanceof ValidationError) {
              return dcRespond(interaction, { content: `${validationReply(error)}\nGo back to Wallets and tap Create wallet to retry.`,
                components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
            }
            throw error;
          }
        }
        if (flow.flow === 'wallet_import') {
          flowState.advance('discord', platformUserId, 'awaiting_key', { chain });
          return dcRespond(interaction, renderFlowStep('wallet_import', 'awaiting_key', { supportedChains, chains }));
        }
        return undefined;
      }

      if (data === 'wallet:balance:pick') {
        return dcRespond(interaction, discordMenus.walletSelect(commands.wallets(userId), { customId: 'wallet:balance:select', emptyHint: 'No wallets yet. Create one first.' }));
      }
      if (data === 'wallet:balance:select') {
        const label = interaction.values?.[0];
        // Checks every supported chain in parallel (see botCommandService.walletBalance) -- a
        // single slow/degraded RPC can still push this past Discord's 3s component-ack window;
        // handleComponent's own up-front defer above is what stops this from timing out.
        const result = await commands.walletBalance(userId, label);
        // result.balance/.symbol never existed on this shape (it's result.balances, one entry per
        // chain) -- this button always showed "Balance: undefined undefined" underneath the
        // timeout. Reuses the exact formatting /wallet balance already uses.
        const lines = result.balances.map(b => `${chains[b.chain]?.name || b.chain}: ${b.balance ?? 'unavailable'} ${b.symbol || ''}`).join('\n');
        return dcRespond(interaction, { content: `## ${result.label}\n${lines}`,
          components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
      }

      if (data === 'wallet:remove:pick') {
        return dcRespond(interaction, discordMenus.walletSelect(commands.wallets(userId), { customId: 'wallet:remove:select', emptyHint: 'No wallets yet.' }));
      }
      if (data === 'wallet:remove:select') {
        return dcRespond(interaction, discordMenus.confirmRemoveWallet(interaction.values?.[0]));
      }
      if (data.startsWith('wallet:remove:do:')) {
        const label = data.slice('wallet:remove:do:'.length);
        await commands.removeWallet(userId, label);
        return dcRespond(interaction, { content: `🗑️ Wallet ${label} removed.`,
          components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])] });
      }

      // Section AA -- every branch below first confirms the CLICKING user (not just anyone who
      // can see the message) owns this exact mint_guided flow at this exact step; flowState is
      // keyed per clicking user, so a stranger's click naturally finds no matching flow and gets
      // an ephemeral rejection rather than ever touching someone else's wallet list or in-progress
      // mint. wentEphemeral decides delivery: the flow's opening message is a public message.reply
      // (Discord can't make that ephemeral), so the owner's first interaction against it strips
      // its buttons and moves everything from here on into an ephemeral reply only they can see;
      // every later step, already ephemeral, just updates in place like any other guided flow.
      if (data === 'flow:mintdetailscontinue') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_details') return notYourMintPrompt(interaction);
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        const wallets = commands.wallets(userId);
        const decision = mintFlowDecision.afterDetails({ data: { ...flow.data, originMessagePublic: false }, wallets });
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return applyMintFlowStep(mintCtx, respond, platformUserId, userId, decision);
      }
      if (data === 'flow:detailsrefresh') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_details') return notYourMintPrompt(interaction);
        let detected;
        try {
          detected = await commands.detectMintContract(userId, { contractAddress: flow.data.contractAddress, quantity: 1, includeStats: Boolean(flow.data.includeStats) });
        } catch {
          return dcRespond(interaction, mintFlowRenderPayload('awaiting_details', flow.data, { chains })); // transient failure -- leave last-known values, still ack the tap
        }
        const refreshed = {
          ...flow.data,
          isSeaDrop: detected.isSeaDrop,
          priceETH: detected.priceKnown ? Number(formatEther(BigInt(detected.valueWei))) : undefined,
          priceUnknown: !detected.priceKnown,
          maxSupply: detected.maxSupply, maxPerWallet: detected.maxPerWallet,
          startTime: detected.startTime, endTime: detected.endTime, collection: detected.collection,
          soldOut: detected.soldOut, displayPrice: detected.displayPrice,
          stats: detected.stats,
        };
        flowState.advance('discord', platformUserId, 'awaiting_details', refreshed);
        return dcRespond(interaction, mintFlowRenderPayload('awaiting_details', refreshed, { chains }));
      }
      if (data === 'flow:copyca') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || !flow.data.contractAddress) return notYourMintPrompt(interaction);
        // A plain ephemeral follow-up, not an update -- purely a copy-friendly echo of the address
        // already shown on the card, so tapping it never touches the flow's own public/ephemeral
        // state or its progression.
        return interaction.followUp({ content: `\`${flow.data.contractAddress}\``, ephemeral: true }).catch(() => {});
      }
      if (data === 'flow:mintqty:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || (flow.flow !== 'mint_guided' && flow.flow !== 'task_guided') || flow.step !== 'awaiting_quantity') return notYourMintPrompt(interaction);
        const chosen = interaction.values?.[0];
        if (chosen === 'custom') {
          if (flow.flow === 'mint_guided' && flow.data.originMessagePublic) {
            neutralizeMintOriginMessage(interaction);
            flowState.advance('discord', platformUserId, flow.step, { originMessagePublic: false });
          }
          return interaction.showModal(discordMenus.numberModal({ customId: 'flow:mintqty:submit', title: `Quantity (max ${flow.data.maxPerWallet || 1})`, placeholder: '1' }));
        }
        const quantity = Number(chosen);
        if (!Number.isInteger(quantity) || quantity < 1) return undefined;
        if (flow.flow === 'task_guided') {
          return advanceFromTaskQuantity(mintCtx, payload => dcRespond(interaction, payload), platformUserId, userId, { ...flow.data, quantity });
        }
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        const wallets = commands.wallets(userId);
        const decision = mintFlowDecision.afterQuantity({ data: { ...flow.data, originMessagePublic: false, quantity }, wallets });
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return applyMintFlowStep(mintCtx, respond, platformUserId, userId, decision);
      }
      if (data === 'flow:mintwallet:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_wallet') return notYourMintPrompt(interaction);
        const label = interaction.values?.[0];
        if (!label) return undefined;
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        const decision = mintFlowDecision.afterWalletSelection({ data: { ...flow.data, originMessagePublic: false, selectedWallets: [label] } });
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return applyMintFlowStep(mintCtx, respond, platformUserId, userId, decision);
      }
      // A batch mint (multi:true) needs more than one wallet in one tap -- Discord's native select
      // menu supports min_values/max_values for exactly this, unlike Telegram's toggle-then-Continue
      // button list (no such component exists there), so this is a single interaction carrying every
      // chosen label in interaction.values instead of a dedicated Continue step.
      if (data === 'flow:mintwalletmulti:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_wallet') return notYourMintPrompt(interaction);
        const labels = interaction.values || [];
        if (!labels.length) return undefined;
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        const decision = mintFlowDecision.afterWalletSelection({ data: { ...flow.data, originMessagePublic: false, selectedWallets: labels } });
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return applyMintFlowStep(mintCtx, respond, platformUserId, userId, decision);
      }
      if (data === 'flow:priceaccept') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_price' || !flow.data.displayPrice) return notYourMintPrompt(interaction);
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        const decision = mintFlowDecision.afterPriceResolved({ data: { ...flow.data, originMessagePublic: false }, priceETH: flow.data.displayPrice.eth });
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return applyMintFlowStep(mintCtx, respond, platformUserId, userId, decision);
      }
      if (data === 'flow:pricemanual') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_price') return notYourMintPrompt(interaction);
        if (flow.data.originMessagePublic) {
          neutralizeMintOriginMessage(interaction);
          flowState.advance('discord', platformUserId, flow.step, { originMessagePublic: false });
        }
        return interaction.showModal(discordMenus.numberModal({ customId: 'flow:mintprice:submit', title: 'Price per item (0 if free)', placeholder: '0.01' }));
      }
      // /batch-mint only -- always already ephemeral by this step (wallet selection, earlier in
      // this same flow, already neutralized any public origin message), so no wentEphemeral dance.
      if (data === 'flow:gastoleranceaccept') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_gastolerance') return notYourMintPrompt(interaction);
        const decision = mintFlowDecision.afterGasToleranceResolved({ data: flow.data, maxGasGwei: null });
        return applyMintFlowStep(mintCtx, payload => dcRespond(interaction, payload), platformUserId, userId, decision);
      }
      if (data === 'flow:gastolerancemanual') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_gastolerance') return notYourMintPrompt(interaction);
        return interaction.showModal(discordMenus.numberModal({ customId: 'flow:gastolerance:submit', title: `Gwei cap (max ${flow.data.gasCeilingGwei})`, placeholder: '30' }));
      }
      if (data === 'flow:mintconfirm') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_confirm') return notYourMintPrompt(interaction);
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        // Simulation + broadcast routinely takes longer than Discord's 3s component-ack window --
        // handleComponent's own up-front defer above is what stops this from showing "the
        // application did not respond" while the mint itself still goes through underneath
        // (finishMintExecutionDiscord's own commands.mint()/batchMint() call keeps running
        // server-side regardless of whether the reply lands in time).
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        return finishMintExecutionDiscord(mintCtx, respond, platformUserId, userId, { ...flow.data, originMessagePublic: false });
      }

      // Section AF follow-up -- Discord's mini schedule flow, branching off the collection card's
      // "Schedule for opening" action (only ever shown there, so only ever reached from
      // mint_guided's awaiting_details step with a genuinely future startTime already confirmed).
      // Re-detects rather than trusting mint_guided's own flow data: whichever stage is live by the
      // time this tap actually happens is what should be scheduled, not whatever was true when the
      // card first rendered, same reasoning as Telegram's startTaskScheduleFlow. Section S (a full
      // Discord guided task-schedule flow) remains unbuilt -- this only ever creates one task per
      // tap; pasting the same contract again and tapping the button again is how a second phase
      // gets scheduled here.
      if (data === 'flow:schedulesuggest') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_details') return notYourMintPrompt(interaction);
        if (!flow.data.startTime || flow.data.startTime * 1000 <= Date.now()) return notYourMintPrompt(interaction);
        const wentEphemeral = Boolean(flow.data.originMessagePublic);
        if (wentEphemeral) neutralizeMintOriginMessage(interaction);
        // Re-detection is a real RPC round trip -- routinely slower than Discord's 3s component-ack
        // window; handleComponent's own up-front defer above is what stops this from timing out.
        const respond = payload => (wentEphemeral ? interaction.followUp({ ...payload, ephemeral: true }).catch(() => {}) : dcRespond(interaction, payload));
        const backToMenu = [discordMenus.row([discordMenus.button('⬅️ Back to menu', 'menu:main')])];
        let detected;
        try {
          detected = await commands.detectMintContract(userId, { contractAddress: flow.data.contractAddress, quantity: 1 });
        } catch {
          return respond({ content: 'Could not re-check this contract right now. Paste the address again to retry.', components: backToMenu });
        }
        const futureStartTime = detected.startTime && detected.startTime * 1000 > Date.now() ? detected.startTime : null;
        if (!detected.priceKnown || !futureStartTime) {
          // Shouldn't happen (a future startTime only ever exists alongside a resolved SeaDrop
          // PublicDrop, which is also where the price comes from) -- degrade honestly rather than
          // proceed with a guess if the contract's state changed underneath this tap.
          return respond({ content: "This contract's price or opening time couldn't be confirmed just now. Use `/task create` to schedule it by hand instead.", components: backToMenu });
        }
        const taskData = {
          contractAddress: flow.data.contractAddress, chain: detected.chain,
          priceETH: Number(formatEther(BigInt(detected.valueWei))), priceUnknown: false,
          mintTime: new Date(futureStartTime * 1000).toISOString(), maxPerWallet: detected.maxPerWallet,
        };
        if (Number(detected.maxPerWallet) > 1) {
          flowState.start('discord', platformUserId, 'task_guided', 'awaiting_quantity', taskData);
          return respond(discordMenus.mintQuantitySelect(taskData));
        }
        return advanceFromTaskQuantity(mintCtx, respond, platformUserId, userId, { ...taskData, quantity: 1 });
      }
      if (data === 'flow:taskwallet:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'task_guided' || flow.step !== 'awaiting_wallet') return notYourMintPrompt(interaction);
        const label = interaction.values?.[0];
        if (!label) return undefined;
        flowState.advance('discord', platformUserId, 'awaiting_name', { ...flow.data, walletLabel: label });
        return dcRespond(interaction, discordMenus.taskNameQuickPicks());
      }
      if (data === 'flow:taskname:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'task_guided' || flow.step !== 'awaiting_name') return notYourMintPrompt(interaction);
        const chosen = interaction.values?.[0];
        if (chosen === 'custom') {
          return interaction.showModal(discordMenus.labelModal({ customId: 'flow:taskname:submit', title: 'Phase name', maxLength: 100 }));
        }
        if (!['GTD', 'FCFS', 'PUBLIC'].includes(chosen)) return undefined;
        const taskData = { ...flow.data, name: chosen };
        flowState.advance('discord', platformUserId, 'awaiting_confirm', taskData);
        return dcRespond(interaction, discordMenus.taskConfirmation({
          name: taskData.name, contractAddress: taskData.contractAddress, chainLabel: chains[taskData.chain]?.name || taskData.chain,
          walletLabel: taskData.walletLabel, quantity: taskData.quantity || 1, mintTime: taskData.mintTime, priceETH: taskData.priceETH, priceUnknown: taskData.priceUnknown,
        }));
      }
      if (data === 'flow:taskconfirm') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'task_guided' || flow.step !== 'awaiting_confirm') return notYourMintPrompt(interaction);
        return finishTaskScheduleDiscord(mintCtx, payload => dcRespond(interaction, payload), platformUserId, userId, flow.data);
      }

      // Watch-rule guided create flow ("/watch has no button" gap) plus the list/manage actions
      // that go with it. Unlike Section AA's mint flow, every one of these is reached from an
      // already-ephemeral message (/menu or menu:watch, exactly like wallet create/import), so
      // there's no public-origin-message complication to handle here.
      if (data === 'menu:watch' || data === 'watch:list') {
        return dcRespond(interaction, discordMenus.watchRulesList(await commands.watchRules(userId)));
      }
      if (data === 'watch:add:start') {
        flowState.start('discord', platformUserId, 'watch_guided', 'awaiting_name');
        return interaction.showModal(discordMenus.labelModal({ customId: 'flow:watchname:submit', title: 'Watch rule name' }));
      }
      if (data === 'flow:watchtype:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'watch_guided' || flow.step !== 'awaiting_type') return undefined;
        const type = interaction.values?.[0];
        flowState.advance('discord', platformUserId, 'awaiting_method', { ...flow.data, type });
        return dcRespond(interaction, discordMenus.watchMethodSelect());
      }
      if (data === 'flow:watchmethod:select') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'watch_guided' || flow.step !== 'awaiting_method') return undefined;
        const method = interaction.values?.[0];
        const fields = watchRuleFlowDecision.configFieldsForType(flow.data.type);
        if (method === 'scraper') fields.push('sourceUrl');
        flowState.advance('discord', platformUserId, 'awaiting_config', { ...flow.data, method });
        return interaction.showModal(discordMenus.watchConfigModal(fields, watchRuleFlowDecision.CONFIG_FIELD_PROMPTS));
      }
      if (data.startsWith('watch:manage:')) {
        const id = data === 'watch:manage:select' ? interaction.values?.[0] : data.slice('watch:manage:'.length);
        const rules = await commands.watchRules(userId);
        const rule = rules.find(item => item.id === id);
        return dcRespond(interaction, rule ? discordMenus.watchRuleActions(rule) : discordMenus.watchRulesList(rules));
      }
      if (data.startsWith('watch:toggle:')) {
        const id = data.slice('watch:toggle:'.length);
        const rules = await commands.watchRules(userId);
        const rule = rules.find(item => item.id === id);
        if (!rule) return dcRespond(interaction, discordMenus.watchRulesList(rules));
        const updated = await commands.updateWatchRule(userId, id, { enabled: !rule.enabled });
        return dcRespond(interaction, discordMenus.watchRuleActions(updated));
      }
      if (data.startsWith('watch:remove:ask:')) {
        const id = data.slice('watch:remove:ask:'.length);
        const rules = await commands.watchRules(userId);
        const rule = rules.find(item => item.id === id);
        return dcRespond(interaction, rule ? discordMenus.confirmRemoveWatchRule(rule) : discordMenus.watchRulesList(rules));
      }
      if (data.startsWith('watch:remove:do:')) {
        const id = data.slice('watch:remove:do:'.length);
        await commands.removeWatchRule(userId, id);
        return dcRespond(interaction, discordMenus.watchRulesList(await commands.watchRules(userId)));
      }
      if (data === 'flow:watchconfirm') {
        const flow = flowState.get('discord', platformUserId);
        if (!flow || flow.flow !== 'watch_guided' || flow.step !== 'awaiting_confirm') return undefined;
        try {
          const rule = await commands.createWatchRule(userId, { name: flow.data.name, type: flow.data.type, method: flow.data.method, config: flow.data.config });
          flowState.clear('discord', platformUserId);
          return dcRespond(interaction, { content: `✅ Watch rule ${rule.name} created using ${rule.method}.`,
            components: [discordMenus.row([discordMenus.button('⬅️ Back to watch rules', 'watch:list')])] });
        } catch (error) {
          flowState.clear('discord', platformUserId);
          if (error instanceof ValidationError) return dcRespond(interaction, { content: validationReply(error), components: [] });
          throw error;
        }
      }

      return undefined;
    } catch (error) {
      if (error instanceof AuthorizationError) {
        await audit({userId,platform:'discord',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(data),outcome:'unauthorized',reason:error.message});
      } else if (error instanceof RateLimitError) {
        await audit({userId,platform:'discord',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(data),outcome:'rate_limited',reason:error.message});
      } else if (error instanceof BotContextError) {
        await audit({platform:'discord',platformUserId:interaction.user?.id,
          contextId:`${interaction.guildId||''}:${interaction.channelId||''}`,command:commandName(data),
          outcome:'invalid_context',reason:error.message});
      } else if (!(error instanceof ValidationError) && !(error instanceof LinkCodeError) && !(error instanceof ProofResolutionError) && !(error instanceof TransactionSafetyError)) {
        log(`Discord component interaction failed: ${error?.message || 'unknown error'}`);
      }
      await dcRespond(interaction, { content: componentErrorMessage(error), components: [] });
    }
  }

  async function handleModal(interaction) {
    let context;
    const data = interaction.customId || '';
    try {
      context = verifyDiscordContext(interaction, allowedGuildId, { allowedChannelIds });
      const platformUserId = context.platformUserId;

      if (data === 'link:code:submit') {
        // Deliberately does not call identity.resolveOrCreate first, same as the /link slash
        // command's consume path: consuming a code attaches this Discord identity to the EXISTING
        // internal user the code was generated for, and must not auto-create a separate identity
        // first. Not part of a guided flow either -- Discord only ever consumes a link code
        // generated on Telegram, so there is no flow-state to check here.
        const code = String(interaction.fields.getTextInputValue('value') || '').trim();
        try {
          const linkedUserId = await identity.consumeLinkCode({ code, platform: 'discord', platformUserId });
          await interaction.reply({ content: `✅ Account linked. Discord now uses GhostMint identity ${linkedUserId}.`, ephemeral: true });
        } catch (error) {
          await interaction.reply({ content: componentErrorMessage(error), ephemeral: true }).catch(() => {});
        }
        return;
      }

      // Both mint modals land here; the only difference is which flow they start. Batch reuses
      // the guided card the /batch-mint slash command already used (multi:true -> wallet
      // multi-select -> quantity -> price -> gas -> confirm) rather than a second implementation.
      if (data === 'menu:mint:submit' || data === 'menu:mint:batch:submit') {
        const multi = data === 'menu:mint:batch:submit';
        // Section O -- menu:mint's modal. Not part of a guided flow (no flowState.start happened
        // when the modal opened), so this is handled here alongside link:code:submit rather than
        // past the flow-required check below. Routes through the exact same startMintGuidedFlow a
        // bare paste and /mint's under-specified path already use -- originMessagePublic:false
        // since a modal reply is already ephemeral, same reasoning as /mint's own modal-adjacent
        // paths.
        const userId = await identity.resolveOrCreate('discord', platformUserId);
        await enforceAccountStatus(userId);
        const contractAddressInput = String(interaction.fields.getTextInputValue('value') || '').trim();
        const started = await startMintGuidedFlow(mintCtx, payload => interaction.reply({ ...payload, ephemeral: true }).catch(() => {}),
          platformUserId, userId, contractAddressInput, { originMessagePublic: false, multi });
        if (started !== undefined) return;
        await interaction.reply({ content: 'Could not find this contract on any supported chain. Double-check the address.', ephemeral: true }).catch(() => {});
        return;
      }

      const userId = await identity.resolveOrCreate('discord', platformUserId);
      await enforceAccountStatus(userId);
      const flow = flowState.get('discord', platformUserId);
      if (!flow) { await interaction.reply({ content: 'This step has expired. Open the Wallets menu again.', ephemeral: true }).catch(() => {}); return; }

      if (data === 'flow:label:submit') {
        const value = String(interaction.fields.getTextInputValue('value') || '').trim();
        if (!value || value.length > 64) { await interaction.reply({ content: 'Label must be 1-64 characters. Tap Create/Import wallet again to retry.', ephemeral: true }).catch(() => {}); return; }
        flowState.advance('discord', platformUserId, 'awaiting_chain', { label: value });
        await interaction.reply({ ...renderFlowStep(flow.flow, 'awaiting_chain', { supportedChains, chains }), ephemeral: true });
        return;
      }
      // Every key the user pastes is appended, so tapping "Add more" builds the list up rather than
      // replacing it. Splitting on any whitespace or comma means one-per-line, all-on-one-line and
      // comma-separated all work -- people paste from wherever they had them.
      if (data === 'flow:batchkeys:submit') {
        const raw = String(interaction.fields.getTextInputValue('value') || '');
        const added = raw.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
        const existing = flow?.data?.privateKeys || [];
        // Clamp here rather than letting importWalletsBatch reject the lot: the card offers no
        // way to remove a key, so an over-cap list would be a dead end with nothing to do but
        // cancel and re-paste.
        const merged = [...existing, ...added];
        const privateKeys = merged.slice(0, LIMITS.batchWalletImport);
        flowState.advance('discord', platformUserId, 'awaiting_key', { privateKeys });
        return interaction.reply({ ...discordMenus.batchImportMenu({ count: privateKeys.length,
          dropped: merged.length - privateKeys.length,
          chainLabel: chains[flow.data.chain]?.name || flow.data.chain }), ephemeral: true }).catch(() => {});
      }

      if (data === 'flow:key:submit') {
        const value = String(interaction.fields.getTextInputValue('value') || '').trim();
        try {
          rateLimiter.check('discord', userId, 'importwallet');
          const wallet = await commands.importWallet(userId, { label: flow.data.label, chain: flow.data.chain, privateKey: value });
          flowState.clear('discord', platformUserId);
          await interaction.reply({ content: `✅ Wallet ${wallet.label} imported at \`${wallet.address}\`.\n⚠️ Not recommended going forward: prefer Create wallet for new wallets.`,
            components: [discordMenus.row([discordMenus.button('⬅️ Back to wallets', 'menu:wallets')])], ephemeral: true });
        } catch (error) {
          if (error instanceof ValidationError) {
            const retryStep = retryStepForField(error);
            if (retryStep === 'awaiting_key') {
              await interaction.reply({ content: `${validationReply(error)}\nTap "Enter private key" again to retry.`,
                components: [discordMenus.row([discordMenus.button('Enter private key', 'wallet:import:key-modal', 'danger'), discordMenus.button('❌ Cancel', 'flow:cancel:ask', 'secondary')])], ephemeral: true }).catch(() => {});
              return;
            }
            flowState.clear('discord', platformUserId);
            await interaction.reply({ content: validationReply(error), ephemeral: true }).catch(() => {});
            return;
          }
          if (error instanceof RateLimitError) {
            await interaction.reply({ content: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`, ephemeral: true }).catch(() => {});
            return;
          }
          flowState.clear('discord', platformUserId);
          log(`Discord guided wallet import failed: ${error?.message || 'unknown error'}`);
          await interaction.reply({ content: 'Import failed safely. Please try again from the Wallets menu.', ephemeral: true }).catch(() => {});
        }
      }

      // Section AA -- custom quantity / manual price entry. Always ephemeral: a modal submission
      // is its own fresh interaction that can only reply, never update the (by now already
      // neutralized -- see flow:mintqty:select/flow:pricemanual) public origin message.
      if (data === 'flow:mintqty:submit') {
        if ((flow.flow !== 'mint_guided' && flow.flow !== 'task_guided') || flow.step !== 'awaiting_quantity') { await interaction.reply({ content: 'This step has expired. Paste the address or link again.', ephemeral: true }).catch(() => {}); return; }
        const quantity = Math.floor(Number(String(interaction.fields.getTextInputValue('value') || '').trim()));
        const max = Number(flow.data.maxPerWallet) || 100;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
          await interaction.reply({ content: `Send a whole number from 1 to ${max}. Tap the quantity prompt again to retry.`, ephemeral: true }).catch(() => {});
          return;
        }
        if (flow.flow === 'task_guided') {
          await advanceFromTaskQuantity(mintCtx, payload => interaction.reply({ ...payload, ephemeral: true }).catch(() => {}), platformUserId, userId, { ...flow.data, quantity });
          return;
        }
        const wallets = commands.wallets(userId);
        const decision = mintFlowDecision.afterQuantity({ data: { ...flow.data, quantity }, wallets });
        await applyMintFlowStep(mintCtx, payload => interaction.reply({ ...payload, ephemeral: true }).catch(() => {}), platformUserId, userId, decision);
        return;
      }
      if (data === 'flow:mintprice:submit') {
        if (flow.flow !== 'mint_guided' || flow.step !== 'awaiting_price') { await interaction.reply({ content: 'This step has expired. Paste the address or link again.', ephemeral: true }).catch(() => {}); return; }
        const priceETH = Number(String(interaction.fields.getTextInputValue('value') || '').trim());
        if (!Number.isFinite(priceETH) || priceETH < 0) {
          await interaction.reply({ content: 'Send a valid non-negative number. Tap the price prompt again to retry.', ephemeral: true }).catch(() => {});
          return;
        }
        const decision = mintFlowDecision.afterPriceResolved({ data: flow.data, priceETH });
        await applyMintFlowStep(mintCtx, payload => interaction.reply({ ...payload, ephemeral: true }).catch(() => {}), platformUserId, userId, decision);
        return;
      }
      if (data === 'flow:gastolerance:submit') {
        if (flow.flow !== 'mint_guided' || flow.step !== 'awaiting_gastolerance') { await interaction.reply({ content: 'This step has expired. Paste the address or link again.', ephemeral: true }).catch(() => {}); return; }
        const maxGasGwei = Number(String(interaction.fields.getTextInputValue('value') || '').trim());
        if (!Number.isFinite(maxGasGwei) || maxGasGwei <= 0) {
          await interaction.reply({ content: 'Send a positive number of gwei. Tap the gas tolerance prompt again to retry.', ephemeral: true }).catch(() => {});
          return;
        }
        const decision = mintFlowDecision.afterGasToleranceResolved({ data: flow.data, maxGasGwei });
        await applyMintFlowStep(mintCtx, payload => interaction.reply({ ...payload, ephemeral: true }).catch(() => {}), platformUserId, userId, decision);
        return;
      }
      if (data === 'flow:taskname:submit') {
        if (flow.flow !== 'task_guided' || flow.step !== 'awaiting_name') { await interaction.reply({ content: 'This step has expired. Tap "Schedule for opening" on the collection card again.', ephemeral: true }).catch(() => {}); return; }
        const name = String(interaction.fields.getTextInputValue('value') || '').trim();
        if (!name || name.length > 100) {
          await interaction.reply({ content: 'Name must be 1-100 characters. Tap the name step again to retry.', ephemeral: true }).catch(() => {});
          return;
        }
        const taskData = { ...flow.data, name };
        flowState.advance('discord', platformUserId, 'awaiting_confirm', taskData);
        await interaction.reply({ ...discordMenus.taskConfirmation({
          name: taskData.name, contractAddress: taskData.contractAddress, chainLabel: chains[taskData.chain]?.name || taskData.chain,
          walletLabel: taskData.walletLabel, quantity: taskData.quantity || 1, mintTime: taskData.mintTime, priceETH: taskData.priceETH, priceUnknown: taskData.priceUnknown,
        }), ephemeral: true });
        return;
      }

      if (data === 'flow:watchname:submit') {
        if (flow.flow !== 'watch_guided' || flow.step !== 'awaiting_name') { await interaction.reply({ content: 'This step has expired. Open the watch rules menu again.', ephemeral: true }).catch(() => {}); return; }
        const name = String(interaction.fields.getTextInputValue('value') || '').trim();
        if (!name || name.length > 100) {
          await interaction.reply({ content: 'Name must be 1-100 characters. Tap "Add a watch rule" again to retry.', ephemeral: true }).catch(() => {});
          return;
        }
        flowState.advance('discord', platformUserId, 'awaiting_type', { ...flow.data, name });
        await interaction.reply({ ...discordMenus.watchTypeSelect(), ephemeral: true });
        return;
      }
      if (data === 'flow:watchconfig:submit') {
        if (flow.flow !== 'watch_guided' || flow.step !== 'awaiting_config') { await interaction.reply({ content: 'This step has expired. Open the watch rules menu again.', ephemeral: true }).catch(() => {}); return; }
        const fields = watchRuleFlowDecision.configFieldsForType(flow.data.type);
        if (flow.data.method === 'scraper') fields.push('sourceUrl');
        const config = {};
        for (const field of fields) {
          const raw = String(interaction.fields.getTextInputValue(field) || '').trim();
          if (!raw) { await interaction.reply({ content: `${field} cannot be empty. Go back and retry that step.`, ephemeral: true }).catch(() => {}); return; }
          config[field] = field === 'keywords' ? raw.split(',').map(item => item.trim()).filter(Boolean)
            : field === 'handle' ? raw.replace(/^@/, '')
            : raw;
        }
        const nextData = { ...flow.data, config };
        flowState.advance('discord', platformUserId, 'awaiting_confirm', nextData);
        await interaction.reply({ ...discordMenus.watchRuleConfirmation(nextData), ephemeral: true });
        return;
      }
    } catch (error) {
      log(`Discord modal submission failed: ${error?.message || 'unknown error'}`);
      await interaction.reply({ content: componentErrorMessage(error), ephemeral: true }).catch(() => {});
    }
  }

  return async interaction => {
    // Suggests the user's own saved wallet labels instead of making them type one exactly.
    // Deliberately lightweight: no flow/rate-limit checks (this never changes anything, it's
    // just a suggestion list), and any failure falls back to an empty list rather than a visible
    // error, since an autocomplete request isn't a command the user consciously submitted.
    if (interaction.isAutocomplete?.()) {
      try {
        const context = verifyDiscordContext(interaction, allowedGuildId, { allowedChannelIds });
        const userId = await identity.resolveOrCreate('discord', context.platformUserId);
        const focused = interaction.options.getFocused(true);
        const choices = (focused.name === 'label' || focused.name === 'wallet') ? commands.wallets(userId).map(w => w.label) : [];
        const query = String(focused.value || '').toLowerCase();
        const filtered = choices.filter(label => label.toLowerCase().includes(query)).slice(0, 25);
        await interaction.respond(filtered.map(label => ({ name: label, value: label })));
      } catch { await interaction.respond([]).catch(() => {}); }
      return;
    }
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) return handleComponent(interaction);
    if (interaction.isModalSubmit?.()) return handleModal(interaction);
    if (!interaction.isChatInputCommand?.()) return;
    let context,userId=null;
    try {
      context=verifyDiscordContext(interaction, allowedGuildId, { allowedChannelIds });
      // Running a different command mid-flow implicitly abandons whatever was in progress -- no
      // confirmation needed, trimmed per user feedback.
      if (flowState.get('discord', context.platformUserId)) flowState.clear('discord', context.platformUserId);
      await interaction.deferReply({ ephemeral: true });
      const discordId = context.platformUserId;
      if (interaction.commandName === 'link') {
        // Discord only ever consumes a link code -- it must never be able to generate one itself.
        // Generate on Telegram with /link, then consume it here or on the dashboard.
        const code = interaction.options.getString('code');
        if (!code) { await interaction.editReply('A link code is required. Generate one with /link on your Telegram account first.'); return; }
        const userId = await identity.consumeLinkCode({ code, platform: 'discord', platformUserId: discordId });
        await interaction.editReply(escapeDiscord(`Account linked. Discord now uses GhostMint identity ${userId}.`));
        return;
      }
      userId = await identity.resolveOrCreate('discord', discordId);
      await enforceAccountStatus(userId);
      if(['wallet','mint','mintnow','batch-mint','admin','watch','sniper','confirm-trigger','target-policy'].includes(interaction.commandName)) {
        rateLimiter.check('discord',userId,interaction.commandName);
      }
      let message;
      switch (interaction.commandName) {
        case 'menu': {
          await interaction.editReply(discordMenus.mainMenu({ isOwner: await ownerFlag(userId) }));
          return;
        }
        // Telegram counterpart to /start: same welcome text, same first-wallet auto-create, same
        // main menu panel underneath. Always shows the welcome text (not just on the very first
        // use, matching /start's own repeat-safe behavior on Telegram) -- only the auto-create is
        // gated to "no wallets yet".
        case 'start': {
          const hadNoWallets = commands.wallets(userId).length === 0;
          if (hadNoWallets) {
            try { await commands.createWallet(userId, { label: 'wallet-1', chain: supportedChains[0] }); }
            catch (error) { log(`Auto wallet creation on /start failed: ${error?.message || 'unknown error'}`); }
          }
          const menu = discordMenus.mainMenu({ isOwner: await ownerFlag(userId) });
          const created = hadNoWallets ? commands.wallets(userId)[0] : null;
          const welcome = 'gm. i mint things.\n\nHere\'s the short version:\n\n'
            + '/mint -- mint from a contract\n/batch-mint -- mint across multiple wallets\n'
            + '/deposit -- get your wallet address\n/wallet -- manage your wallets\n/menu -- this again\n\n'
            + 'Paste a contract address to get going.';
          const createdLine = created ? `\n\nWallet created: ${created.label} -- \`${created.address}\`` : '';
          await interaction.editReply({ content: `${welcome}${createdLine}\n\n${menu.content}`, components: menu.components });
          return;
        }
        case 'deposit': {
          const wallets = commands.wallets(userId);
          if (!wallets.length) { message = 'No wallets yet. Use `/wallet create` first.'; break; }
          const label = interaction.options.getString('label');
          const target = label ? wallets.find(w => w.label === label) : (wallets.length === 1 ? wallets[0] : null);
          if (!target) { message = `You have multiple wallets -- specify one: ${wallets.map(w => w.label).join(', ')}.`; break; }
          message = `Send funds to ${target.label}: \`${target.address}\`. This address works on any EVM chain (${target.chain} is its home chain here).`;
          break;
        }
        case 'wallet': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') {
            const value = await commands.createWallet(userId, { label: interaction.options.getString('label'), chain: interaction.options.getString('chain') });
            message = `Wallet ${value.label} generated securely: \`${value.address}\` (${value.chain}). Fund this public address to use it. The private key was encrypted at creation and is never returned through Discord.`;
          } else if (action === 'import') {
            const value = await commands.importWallet(userId, { label: interaction.options.getString('label'), chain: interaction.options.getString('chain'), privateKey: interaction.options.getString('private-key') });
            message = `Wallet ${value.label} imported: \`${value.address}\`. ⚠️ Import through Discord is not recommended because the key passed through platform message transit and may remain in client history or notification previews. Prefer generated wallets; a future HTTPS dashboard will provide a safer import path.`;
          } else if (action === 'list') message = formatRows(commands.wallets(userId), 'No wallets yet.', item => `${item.label} — \`${item.address}\` — ${item.chain}`);
          else if (action === 'balance') {
            const value = await commands.walletBalance(userId, interaction.options.getString('label'));
            const lines = value.balances.map(b => `${chains[b.chain]?.name || b.chain}: ${b.balance ?? 'unavailable'} ${b.symbol || ''}`).join('\n');
            message = `## ${value.label}\n${lines}`;
          }
          else if (action === 'batch-import') {
            confirmation(interaction);
            const keys = interaction.options.getString('private-keys').split(',').map(v => v.trim()).filter(Boolean);
            const results = await commands.importWalletsBatch(userId, { privateKeys: keys,
              chain: interaction.options.getString('chain'), labelPrefix: interaction.options.getString('label-prefix') || undefined });
            const succeeded = results.filter(r => r.status === 'success');
            const failed = results.filter(r => r.status === 'failed');
            const lines = [`Batch import: ${succeeded.length} succeeded, ${failed.length} failed.`,
              ...succeeded.map(r => `✅ ${r.label} — \`${r.address}\``),
              ...failed.map(r => `❌ #${r.index + 1}: ${r.error}`)];
            message = lines.join('\n').slice(0, 1900);
          }
          else if (action === 'remove') { confirmation(interaction); message = `Wallet ${await commands.removeWallet(userId, interaction.options.getString('label'))} removed.`; }
          break;
        }
        case 'mint': {
          const walletLabel = interaction.options.getString('wallet');
          const quantity = interaction.options.getInteger('quantity');
          if (!walletLabel || quantity === null) {
            // Under-specified: auto-detect which chain the contract actually lives on and show the
            // collection card, same as pasting the address, rather than guessing the wallet's own
            // home chain (see startMintGuidedFlow's originMessagePublic note on why false here).
            const started = await startMintGuidedFlow(mintCtx, payload => interaction.editReply(payload),
              context.platformUserId, userId, interaction.options.getString('contract'), { originMessagePublic: false });
            if (started !== undefined) return;
            message = 'Could not find this contract on any supported chain. Double-check the address.';
            break;
          }
          // Fully specified (wallet+quantity both given) skips startMintGuidedFlow entirely, which
          // is the only other place that resolves an OpenSea link -- resolve it here too, or
          // pasting a link into a fully-specified /mint would fail validation (ethereumAddress()
          // rejects anything that isn't a literal 0x address) even though the same link works fine
          // through the under-specified path above. Falls back to the raw input on a resolution
          // miss so the existing "must be a valid Ethereum address" message still fires normally.
          const rawContract = interaction.options.getString('contract');
          const contractAddress = await commands.resolveMintContractInput(rawContract) || rawContract;
          const result = await commands.mint(userId, { walletLabel, contractAddress, quantity, priceETH: interaction.options.getNumber('price'), chain: interaction.options.getString('chain') });
          message = `Mint ${result.state}: ${result.txHash || result.intentId}`; break;
        }
        case 'info': {
          const started = await startMintGuidedFlow(mintCtx, payload => interaction.editReply(payload),
            context.platformUserId, userId, interaction.options.getString('contract'), { originMessagePublic: false, includeStats: true });
          if (started !== undefined) return;
          message = 'Could not find this contract on any supported chain. Double-check the address.';
          break;
        }
        case 'mintnow': {
          const started = await startMintNowFlow(mintCtx, payload => interaction.editReply(payload),
            context.platformUserId, userId, interaction.options.getString('contract'));
          if (started !== undefined) return;
          message = 'Could not find this contract on any supported chain. Double-check the address.';
          break;
        }
        case 'batch-mint': {
          const walletsInput = interaction.options.getString('wallets');
          const quantity = interaction.options.getInteger('quantity');
          const price = interaction.options.getNumber('price');
          if (!walletsInput || quantity === null || price === null) {
            // Under-specified: same auto-detecting collection card /mint's own under-specified path
            // uses, just with multi:true so the wallet step becomes a real multi-select.
            const started = await startMintGuidedFlow(mintCtx, payload => interaction.editReply(payload),
              context.platformUserId, userId, interaction.options.getString('contract'), { originMessagePublic: false, multi: true });
            if (started !== undefined) return;
            message = 'Could not find this contract on any supported chain. Double-check the address.';
            break;
          }
          // Same OpenSea-link resolution as /mint's fully-specified branch above, same reason.
          const rawContract = interaction.options.getString('contract');
          const contractAddress = await commands.resolveMintContractInput(rawContract) || rawContract;
          const results = await commands.batchMint(userId, { walletLabels: walletsInput.split(',').map(v => v.trim()), contractAddress, quantity, priceETH: price, chain: interaction.options.getString('chain') });
          // Per wallet, not a count. batchMint stopped throwing on a per-wallet failure, so a
          // bare length here reported a batch where every wallet failed as an unqualified
          // success -- the guided flow was updated for this and this path was missed.
          {
            const ok = results.filter(item => item.state !== 'failed');
            const lines = results.map(item => (item.state === 'failed'
              ? `❌ **${escapeDiscord(String(item.walletLabel))}** — ${escapeDiscord(String(item.error || 'failed'))}`
              : `✅ **${escapeDiscord(String(item.walletLabel))}** — ${escapeDiscord(String(item.state || 'submitted'))}`
                + (item.txHash ? ` \`${item.txHash}\`` : '')));
            message = `**Batch mint — ${ok.length} of ${results.length} submitted**\n${lines.join('\n')}`;
          }
          break;
        }
        case 'task': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') { confirmation(interaction); const task = await commands.createTask(userId, json(interaction.options.getString('input'))); message = `Task ${task.name} scheduled for ${discordMenus.formatGmtPlus1(task.mintTime)} (ID: ${task.id}).`; }
          else if (action === 'list') { const page=await commands.tasksPage(userId,{page:interaction.options.getInteger('page')||1}); message=`${formatRows(page.items,'No scheduled tasks.',task=>`${task.name} [${task.status}] — ${discordMenus.formatGmtPlus1(task.mintTime)} — ${task.id}`)}\nPage ${page.page}/${page.totalPages} (${page.total} total)`; }
          else { if (['cancel', 'resume', 'retry'].includes(action)) confirmation(interaction); const task = await commands.controlTask(userId, action, interaction.options.getString('id')); message = `Task ${task.name} is now ${task.status}.`; }
          break;
        }
        case 'activity': { const page=await commands.activityPage(userId,{page:interaction.options.getInteger('page')||1}); message=`${formatRows(page.items,'No activity yet.',item=>`${item.status}: ${item.title} — ${item.walletLabel}`)}\nPage ${page.page}/${page.totalPages} (${page.total} total)`; break; }
        case 'pnl': {
          const action = interaction.options.getSubcommand();
          if (action === 'list') message = formatRows(commands.pnl(userId), 'No P&L records.', item => `#${item.id} ${item.nm} — net ${item.net}`);
          else if (action === 'add') { const record = await commands.addPnl(userId, json(interaction.options.getString('input'))); message = `P&L record #${record.id} saved.`; }
          else { confirmation(interaction); message = `P&L record #${await commands.deletePnl(userId, interaction.options.getString('id'))} deleted.`; }
          break;
        }
        case 'gas': {
          const gasChain = interaction.options.getString('chain') || 'ethereum';
          // Telegram's /gas already degrades to "unavailable" on a lookup failure (gasMenu with
          // null fees) instead of showing a raw error -- this matched that instead of falling
          // through to the generic "Command failed safely" catch-all below, which gave no hint
          // that the chain itself (not the command) was the problem.
          const value = await commands.gas(gasChain).catch(() => null);
          message = value
            ? `${value.chain}: gas ${value.gasPriceGwei ?? 'unavailable'} Gwei, max fee ${value.maxFeePerGasGwei ?? 'unavailable'} Gwei.`
            : `${gasChain}: gas data unavailable right now.`;
          break;
        }
        case 'sniper': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') { confirmation(interaction);const sniper = await commands.createSniper(userId, json(interaction.options.getString('input'))); message = `Post-confirmation copy sniper ${sniper.label} created. This is not mempool front-running.`; }
          else if (action === 'update') { confirmation(interaction);const sniper = await commands.updateSniper(userId, interaction.options.getString('id'), json(interaction.options.getString('patch'))); message = `Post-confirmation copy sniper ${sniper.label} updated.`; }
          else { const values = commands.snipers(userId); const selected = action === 'status' ? values.filter(item => item.id === interaction.options.getString('id')) : values; message = `Post-confirmation copying only; not mempool front-running.\n${formatRows(selected, 'No matching snipers.', item => `${item.label} [${item.active ? 'active' : 'inactive'}] — ${item.id}`)}`; }
          break;
        }
        case 'mode': confirmation(interaction);message = `Transaction mode set to ${await commands.selectMode(userId, interaction.options.getString('preset'))}.`; break;
        case 'admin': confirmation(interaction);message = await commands.admin(userId, interaction.options.getString('action')); break;
        case 'watch': {
          const action = interaction.options.getSubcommand();
          if (action === 'add') { const rule = await commands.createWatchRule(userId, json(interaction.options.getString('input'))); message = `Social watch rule ${rule.name} created with ${rule.method}.`; }
          else if (action === 'edit') { const rule = await commands.updateWatchRule(userId, interaction.options.getString('id'), json(interaction.options.getString('patch'))); message = `Social watch rule ${rule.name} updated; ${rule.method} adapter selected.`; }
          else if (action === 'disable') { const rule = await commands.disableWatchRule(userId, interaction.options.getString('id')); message = `Social watch rule ${rule.name} disabled.`; }
          else if (action === 'remove') { confirmation(interaction); const id = await commands.removeWatchRule(userId, interaction.options.getString('id')); message = `Social watch rule ${id} removed.`; }
          else message = formatRows(await commands.watchRules(userId), 'No social watch rules.', rule => `${rule.name} [${rule.enabled ? 'enabled' : 'disabled'}] — ${rule.type} via ${rule.method} — ${rule.id}`);
          break;
        }
        case 'social-usage': {
          const summary = await commands.socialUsage(userId, interaction.options.getString('period') || 'month');
          const rows = summary.rows.length ? summary.rows.map(row => `${row.ruleName} | ${row.method}: ${row.requests}`).join('\n') : 'No requests recorded.';
          const tiers = summary.breakEvenRequests.map(tier => `$${tier.price}/mo: ~${tier.atReadRate.toLocaleString('en-US')} reads`).join('\n');
          message = `Social adapter usage (${summary.period})\nTotal: ${summary.requests}\n${rows}\nEstimated pay-per-use: ~$${summary.payPerUseEstimateUsd.toFixed(2)}\nProjected monthly requests: ~${Math.round(summary.projectedMonthlyRequests).toLocaleString('en-US')}\n${tiers}`;
          break;
        }
        case 'target-policy': {
          const action=interaction.options.getSubcommand();
          if(action==='set'){confirmation(interaction);const policy=await commands.updateTargetPolicy(userId,json(interaction.options.getString('input')));message=`Target policy saved: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}.`;}
          else if(action==='show'){const policy=await commands.targetPolicy(userId,interaction.options.getString('type'),interaction.options.getString('id'));message=JSON.stringify(policy);}
          else if(action==='bypass'){const result=await commands.requestTargetBypass(userId,{targetType:interaction.options.getString('type'),targetId:interaction.options.getString('id'),dontAskAgain:interaction.options.getBoolean('dont-ask-again')===true});message=result.requiresConfirmation?`${result.warning}\nChallenge: ${result.challengeId}`:'Verification bypass enabled for this previously acknowledged target.';}
          else if(action==='confirm-bypass'){const policy=await commands.confirmTargetBypass(userId,{challengeId:interaction.options.getString('challenge'),confirmation:interaction.options.getString('confirmation')});message=`Verification is now ${policy.humanVerification} for this target.`;}
          else if(action==='preset'){confirmation(interaction);const result=await commands.applyTargetPreset(userId,json(interaction.options.getString('input')));message=result.requiresConfirmation?`${result.warning}\nChallenge: ${result.challengeId}`:`Target preset applied; verification ${result.humanVerification}.`;}
          else {confirmation(interaction);const policy=await commands.resetTargetPolicy(userId,{targetType:interaction.options.getString('type'),targetId:interaction.options.getString('id')});message=`Target policy reset. Verification is ${policy.humanVerification}; bypass acknowledgement cleared.`;}
          break;
        }
        case 'confirm-trigger': {const result=await commands.confirmTrigger(userId,interaction.options.getString('request'),interaction.options.getString('confirmation'));message=result.action==='rejected'?'Trigger rejected.':`Triggered mint ${result.result.state}.`;break;}
        case 'trigger-audit': {const rows=await commands.triggerAudit(userId);message=rows.length?rows.map(row=>`${row.trigger_source} | ${row.target_type}:${row.target_id} | verification ${row.verification_state} | ${row.outcome}`).join('\n'):'No trigger executions audited.';break;}
        case 'pending': {const [transactions,confirmations]=await Promise.all([commands.pendingTransactions(userId),commands.pendingConfirmations(userId)]);
          message=`Pending transactions: ${transactions.length}\n${transactions.map(row=>`${row.intentId} | ${row.state} | ${row.chain}`).join('\n')||'None'}\n\nPending confirmations: ${confirmations.length}\n${confirmations.map(row=>`${row.id} | ${row.triggerSource} | expires ${new Date(row.expiresAt).toISOString()}`).join('\n')||'None'}`;break;}
        case 'transactions': {const page=await commands.transactionsPage(userId,{page:interaction.options.getInteger('page')||1});message=`${formatRows(page.items,'No transactions.',row=>`${row.intentId} | ${row.state} | ${row.chain}`)}\nPage ${page.page}/${page.totalPages} (${page.total} total)`;break;}
        default: throw new Error('Unknown Discord command');
      }
      message=escapeDiscord(message);
      await interaction.editReply(message);
    } catch (error) {
      let message = 'Command failed safely. Please try again.';
      if (error instanceof ValidationError) message = escapeDiscord(validationReply(error));
      else if (error instanceof AccountBlockedError) { message = escapeDiscord(`⛔ Your account is ${error.status}${error.reason ? `: ${error.reason}` : ''}. Contact the project owner if you believe this is a mistake.`);
        await audit({userId,platform:'discord',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(interaction.commandName),outcome:'account_blocked',reason:error.message}); }
      else if (error instanceof AuthorizationError) { message = 'Owner access required.';
        await audit({userId,platform:'discord',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(interaction.commandName),outcome:'unauthorized',reason:error.message}); }
      else if (error instanceof RateLimitError) { message=`Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`;
        await audit({userId,platform:'discord',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(interaction.commandName),outcome:'rate_limited',reason:error.message}); }
      else if (error instanceof BotContextError) { message='Command rejected: this bot is not enabled here. Use an allowed channel, or DM it directly.';
        await audit({platform:'discord',platformUserId:interaction.user?.id,
          contextId:`${interaction.guildId||''}:${interaction.channelId||''}`,command:commandName(interaction.commandName),
          outcome:'invalid_context',reason:error.message}); }
      else if (error instanceof LinkCodeError || error instanceof ProofResolutionError || error instanceof TransactionSafetyError) message = escapeDiscord(error.message);
      else log(`Discord command failed: ${error?.message || 'unknown error'}`);
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  };
}

// Section AA -- exported separately (mirroring createDiscordInteractionHandler) so tests can drive
// the paste-to-flow trigger directly with a mock message, without needing a real discord.js
// Client. Telegram counterpart: a bare contract address or opensea.io collection link (Section
// Q), with no leading slash and no active flow, starts the same guided mint flow Section AA's
// other entry points do (server.js's handleFlowTextMessage does the equivalent for Telegram). Any
// other plain message, and anything failing the same guild/channel/account checks every slash
// command already enforces, is silently ignored -- a failed check here is never worth surfacing
// as an error to a channel that may not even be the bot's.
async function handleMintPasteMessage({ identity, commands, flowState, chains, rateLimiter, checkAccountStatus, allowedGuildId, allowedChannelIds=null }, message) {
  try {
    if (!message.author || message.author.bot) return;
    const trimmed = String(message.content || '').trim();
    const looksAddressOrLink = /^0x[0-9a-fA-F]{40}$/.test(trimmed) || commands.parseOpenSeaCollectionSlug(trimmed);
    if (!looksAddressOrLink) return;
    const context = verifyDiscordContext({ user: message.author, guildId: message.guildId, channelId: message.channelId }, allowedGuildId, { allowedChannelIds });
    const userId = await identity.resolveOrCreate('discord', context.platformUserId);
    if (typeof checkAccountStatus === 'function') await checkAccountStatus(userId);
    const platformUserId = context.platformUserId;
    // Mirrors the mid-flow divergence handling every slash command and component already gets: a
    // second paste while a flow (mint or otherwise) is already in progress implicitly abandons it
    // and starts fresh with the new address -- no confirmation needed, trimmed per user feedback.
    if (flowState.get('discord', platformUserId)) flowState.clear('discord', platformUserId);
    await startMintGuidedFlow({ commands, flowState, chains, rateLimiter }, payload => message.reply(payload).catch(() => {}), platformUserId, userId, trimmed);
  } catch { /* not address-shaped, unauthorized context, blocked account, or lookup failure -- ignore */ }
}

// Global registration does not replace commands previously registered to a guild -- Discord keeps
// the two sets independently and renders both, so a guild left over from a DISCORD_DEV_GUILD_ID
// that has since been removed would show every command twice. One idempotent empty write per guild
// clears that. Best-effort by design: a bot that cannot tidy old commands should still start.
async function clearLeftoverGuildCommands({ api, applicationId, log }) {
  try {
    const guilds = await api.get(Routes.userGuilds());
    for (const guild of guilds) {
      const existing = await api.get(Routes.applicationGuildCommands(applicationId, guild.id)).catch(() => []);
      if (!existing.length) continue;
      await api.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [] });
      log(`Cleared ${existing.length} stale guild-scoped commands from ${guild.id}`);
    }
  } catch (error) {
    log(`Could not clear stale guild-scoped commands: ${error.message}`);
  }
}

function createDiscordBot({ token, applicationId, devGuildId, allowedChannelIds=null, identity, commands, securityAudit, rateLimiter, log = () => {}, client, rest, isOwner, checkAccountStatus, supportedChains, chains }) {
  const discordClient = client || new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const api = rest || new REST({ version: '10' }).setToken(token);
  // Shared between the interaction handler (every button/select/modal step below) and the
  // messageCreate listener (Section AA's paste-to-flow trigger) so a flow started by one is
  // visible to the other -- they'd otherwise be two independent, non-communicating stores.
  const flowState = createFlowStateStore();
  discordClient.on('interactionCreate', createDiscordInteractionHandler({ identity, commands, allowedGuildId:devGuildId || null, allowedChannelIds,
    securityAudit,rateLimiter,log,isOwner,checkAccountStatus,supportedChains,chains,flowState }));
  discordClient.on('messageCreate', message =>
    handleMintPasteMessage({ identity, commands, flowState, chains, rateLimiter, checkAccountStatus, allowedGuildId: devGuildId || null, allowedChannelIds }, message));
  return {
    client: discordClient,
    // devGuildId set = development bot: commands register to that one guild only (which is instant,
    // where global registration can take up to an hour to propagate) and allowedGuildId above locks
    // every command to it. Unset = commands register globally, so the bot serves every server it is
    // in plus DMs. Registering global commands does NOT remove commands previously registered to a
    // guild -- Discord keeps the two sets independently and shows both, so switching from a dev
    // guild to global means clearing that guild's commands or they appear twice.
    async start() {
      const route = devGuildId
        ? Routes.applicationGuildCommands(applicationId, devGuildId)
        : Routes.applicationCommands(applicationId);
      await api.put(route, { body: commandDefinitions({ supportedChains, chains }) });
      if (!devGuildId) await clearLeftoverGuildCommands({ api, applicationId, log });
      await discordClient.login(token);
      return discordClient.user;
    },
    async sendDirectMessage(platformUserId, message) {
      const user = await discordClient.users.fetch(platformUserId);
      await user.send({ content: escapeDiscord(message) });
    },
    async stop() { await discordClient.destroy(); },
  };
}

module.exports = { commandDefinitions, createDiscordBot, createDiscordInteractionHandler, handleMintPasteMessage };
