const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const { AuthorizationError } = require('../governance/governanceService');
const { LinkCodeError } = require('../identity/identityService');
const { ProofResolutionError } = require('../mint/proofResolver');
const { ValidationError, validationReply } = require('../validation/domain');

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

function commandDefinitions() {
  const commands = [];
  commands.push(new SlashCommandBuilder().setName('wallet').setDescription('Manage your wallets')
    .addSubcommand(c => c.setName('create').setDescription('Recommended: generate and securely store a new wallet')
      .addStringOption(o => o.setName('label').setDescription('Unique wallet label').setRequired(true))
      .addStringOption(o => o.setName('chain').setDescription('Supported chain').setRequired(true)))
    .addSubcommand(c => c.setName('import').setDescription('Not recommended: private key passes through Discord message systems')
      .addStringOption(o => o.setName('label').setDescription('Unique wallet label').setRequired(true))
      .addStringOption(o => o.setName('chain').setDescription('Supported chain').setRequired(true))
      .addStringOption(o => o.setName('private-key').setDescription('Existing key; may be exposed in platform transit or client history').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your wallets'))
    .addSubcommand(c => c.setName('balance').setDescription('Read wallet balance')
      .addStringOption(o => o.setName('label').setDescription('Wallet label').setRequired(true)))
    .addSubcommand(c => c.setName('remove').setDescription('Permanently remove a wallet')
      .addStringOption(o => o.setName('label').setDescription('Wallet label').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm permanent removal').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('mint').setDescription('Execute a supported mint')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet label').setRequired(true))
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true))
    .addIntegerOption(o => o.setName('quantity').setDescription('Quantity').setMinValue(1).setRequired(true))
    .addNumberOption(o => o.setName('price').setDescription('Native price per item').setMinValue(0).setRequired(true))
    .addBooleanOption(o => o.setName('confirm').setDescription('Confirm value-bearing action').setRequired(true))
    .addStringOption(o => o.setName('chain').setDescription('Chain (defaults to wallet chain)')));
  commands.push(new SlashCommandBuilder().setName('batch-mint').setDescription('Mint from multiple wallets')
    .addStringOption(o => o.setName('wallets').setDescription('Comma-separated wallet labels').setRequired(true))
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(true))
    .addIntegerOption(o => o.setName('quantity').setDescription('Quantity per wallet').setMinValue(1).setRequired(true))
    .addNumberOption(o => o.setName('price').setDescription('Native price per item').setMinValue(0).setRequired(true))
    .addStringOption(o => o.setName('chain').setDescription('Chain').setRequired(true))
    .addBooleanOption(o => o.setName('confirm').setDescription('Confirm value-bearing batch').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('task').setDescription('Manage durable scheduled mints')
    .addSubcommand(c => c.setName('create').setDescription('Create a UTC scheduled mint')
      .addStringOption(o => o.setName('input').setDescription('Validated task JSON; mintTime must include Z/offset').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm scheduled value-bearing action').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your scheduled tasks'))
    .addSubcommand(c => c.setName('cancel').setDescription('Cancel a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm cancellation').setRequired(true)))
    .addSubcommand(c => c.setName('pause').setDescription('Pause a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)))
    .addSubcommand(c => c.setName('resume').setDescription('Resume a task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)))
    .addSubcommand(c => c.setName('retry').setDescription('Retry a failed task').addStringOption(o => o.setName('id').setDescription('Task UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm retry').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('activity').setDescription('Show your recent mint activity'));
  commands.push(new SlashCommandBuilder().setName('pnl').setDescription('Manage your P&L records')
    .addSubcommand(c => c.setName('list').setDescription('List your P&L records'))
    .addSubcommand(c => c.setName('add').setDescription('Add a P&L record').addStringOption(o => o.setName('input').setDescription('Record JSON').setRequired(true)))
    .addSubcommand(c => c.setName('delete').setDescription('Delete a P&L record').addIntegerOption(o => o.setName('id').setDescription('Record ID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm deletion').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('gas').setDescription('Show live chain fee data')
    .addStringOption(o => o.setName('chain').setDescription('Supported chain')));
  commands.push(new SlashCommandBuilder().setName('sniper').setDescription('Manage post-confirmation copy snipers (not mempool front-running)')
    .addSubcommand(c => c.setName('create').setDescription('Create post-confirmation copy sniper').addStringOption(o => o.setName('input').setDescription('Validated sniper JSON').setRequired(true)))
    .addSubcommand(c => c.setName('update').setDescription('Update post-confirmation copy sniper').addStringOption(o => o.setName('id').setDescription('Sniper UUID').setRequired(true)).addStringOption(o => o.setName('patch').setDescription('Validated patch JSON').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List post-confirmation copy snipers'))
    .addSubcommand(c => c.setName('status').setDescription('Show a post-confirmation copy sniper').addStringOption(o => o.setName('id').setDescription('Sniper UUID').setRequired(true))));
  commands.push(new SlashCommandBuilder().setName('mode').setDescription('Select your transaction mode preset')
    .addStringOption(o => o.setName('preset').setDescription('Preset key').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('admin').setDescription('Owner-only governance command')
    .addStringOption(o => o.setName('action').setDescription('Governance action and arguments').setRequired(true)));
  commands.push(new SlashCommandBuilder().setName('link').setDescription('Create or consume a cross-platform account link code')
    .addStringOption(o => o.setName('code').setDescription('Single-use code from your existing account')));
  commands.push(new SlashCommandBuilder().setName('watch').setDescription('Manage social contract-address watch rules')
    .addSubcommand(c => c.setName('add').setDescription('Add a social watch rule').addStringOption(o => o.setName('input').setDescription('Watch rule JSON').setRequired(true)))
    .addSubcommand(c => c.setName('edit').setDescription('Edit a rule or switch its adapter method').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)).addStringOption(o => o.setName('patch').setDescription('Watch rule patch JSON').setRequired(true)))
    .addSubcommand(c => c.setName('disable').setDescription('Disable a social watch rule').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)))
    .addSubcommand(c => c.setName('remove').setDescription('Remove a social watch rule').addStringOption(o => o.setName('id').setDescription('Rule UUID').setRequired(true)).addBooleanOption(o => o.setName('confirm').setDescription('Confirm permanent removal').setRequired(true)))
    .addSubcommand(c => c.setName('list').setDescription('List your social watch rules')));
  commands.push(new SlashCommandBuilder().setName('social-usage').setDescription('Owner-only social adapter usage and cost estimates')
    .addStringOption(o => o.setName('period').setDescription('Reporting period').addChoices(
      { name:'Today', value:'today' }, { name:'This month', value:'month' })));
  return commands.map(command => command.toJSON());
}

function formatRows(rows, empty, mapper) {
  return rows.length ? rows.map(mapper).join('\n') : empty;
}

function createDiscordInteractionHandler({ identity, commands, log = () => {} }) {
  return async interaction => {
    if (!interaction.isChatInputCommand?.()) return;
    try {
      await interaction.deferReply({ ephemeral: true });
      const discordId = interaction.user.id;
      if (interaction.commandName === 'link' && interaction.options.getString('code')) {
        const userId = await identity.consumeLinkCode({ code: interaction.options.getString('code'),
          platform: 'discord', platformUserId: discordId });
        await interaction.editReply(`Account linked. Discord now uses GhostMint identity ${userId}.`);
        return;
      }
      const userId = await identity.resolveOrCreate('discord', discordId);
      let message;
      switch (interaction.commandName) {
        case 'link': {
          const link = await identity.createLinkCode(userId);
          message = `Account link code: **${link.code}**\nExpires in 5 minutes and can be used once.`; break;
        }
        case 'wallet': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') {
            const value = await commands.createWallet(userId, { label: interaction.options.getString('label'), chain: interaction.options.getString('chain') });
            message = `Wallet **${value.label}** generated securely: \`${value.address}\` (${value.chain}). Fund this public address to use it. The private key was encrypted at creation and is never returned through Discord.`;
          } else if (action === 'import') {
            const value = await commands.importWallet(userId, { label: interaction.options.getString('label'), chain: interaction.options.getString('chain'), privateKey: interaction.options.getString('private-key') });
            message = `Wallet **${value.label}** imported: \`${value.address}\`. ⚠️ Import through Discord is not recommended because the key passed through platform message transit and may remain in client history or notification previews. Prefer generated wallets; a future HTTPS dashboard will provide a safer import path.`;
          } else if (action === 'list') message = formatRows(commands.wallets(userId), 'No wallets yet.', item => `**${item.label}** — \`${item.address}\` — ${item.chain}`);
          else if (action === 'balance') { const value = await commands.walletBalance(userId, interaction.options.getString('label')); message = `**${value.label}**: ${value.balance} ${value.symbol}`; }
          else { confirmation(interaction); message = `Wallet **${await commands.removeWallet(userId, interaction.options.getString('label'))}** removed.`; }
          break;
        }
        case 'mint': {
          confirmation(interaction); const result = await commands.mint(userId, { walletLabel: interaction.options.getString('wallet'), contractAddress: interaction.options.getString('contract'), quantity: interaction.options.getInteger('quantity'), priceETH: interaction.options.getNumber('price'), chain: interaction.options.getString('chain') });
          message = `Mint ${result.state}: ${result.txHash || result.intentId}`; break;
        }
        case 'batch-mint': {
          confirmation(interaction); const results = await commands.batchMint(userId, { walletLabels: interaction.options.getString('wallets').split(',').map(v => v.trim()), contractAddress: interaction.options.getString('contract'), quantity: interaction.options.getInteger('quantity'), priceETH: interaction.options.getNumber('price'), chain: interaction.options.getString('chain') });
          message = `Batch complete: ${results.length} wallet transaction(s).`; break;
        }
        case 'task': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') { confirmation(interaction); const task = await commands.createTask(userId, json(interaction.options.getString('input'))); message = `Task **${task.name}** scheduled for ${new Date(task.mintTime).toISOString()} UTC (ID: ${task.id}).`; }
          else if (action === 'list') message = formatRows(await commands.tasks(userId), 'No scheduled tasks.', task => `**${task.name}** [${task.status}] — ${new Date(task.mintTime).toISOString()} — ${task.id}`);
          else { if (['cancel', 'retry'].includes(action)) confirmation(interaction); const task = await commands.controlTask(userId, action, interaction.options.getString('id')); message = `Task **${task.name}** is now ${task.status}.`; }
          break;
        }
        case 'activity': message = formatRows(commands.activity(userId), 'No activity yet.', item => `${item.status}: ${item.title} — ${item.walletLabel}`); break;
        case 'pnl': {
          const action = interaction.options.getSubcommand();
          if (action === 'list') message = formatRows(commands.pnl(userId), 'No P&L records.', item => `#${item.id} **${item.nm}** — net ${item.net}`);
          else if (action === 'add') { const record = await commands.addPnl(userId, json(interaction.options.getString('input'))); message = `P&L record #${record.id} saved.`; }
          else { confirmation(interaction); message = `P&L record #${await commands.deletePnl(userId, interaction.options.getInteger('id'))} deleted.`; }
          break;
        }
        case 'gas': { const value = await commands.gas(interaction.options.getString('chain') || 'ethereum'); message = `${value.chain}: gas ${value.gasPriceGwei ?? 'unavailable'} Gwei, max fee ${value.maxFeePerGasGwei ?? 'unavailable'} Gwei.`; break; }
        case 'sniper': {
          const action = interaction.options.getSubcommand();
          if (action === 'create') { const sniper = await commands.createSniper(userId, json(interaction.options.getString('input'))); message = `Post-confirmation copy sniper **${sniper.label}** created. This is not mempool front-running.`; }
          else if (action === 'update') { const sniper = await commands.updateSniper(userId, interaction.options.getString('id'), json(interaction.options.getString('patch'))); message = `Post-confirmation copy sniper **${sniper.label}** updated.`; }
          else { const values = commands.snipers(userId); const selected = action === 'status' ? values.filter(item => item.id === interaction.options.getString('id')) : values; message = `Post-confirmation copying only; not mempool front-running.\n${formatRows(selected, 'No matching snipers.', item => `**${item.label}** [${item.active ? 'active' : 'inactive'}] — ${item.id}`)}`; }
          break;
        }
        case 'mode': message = `Transaction mode set to **${await commands.selectMode(userId, interaction.options.getString('preset'))}**.`; break;
        case 'admin': message = await commands.admin(userId, interaction.options.getString('action')); break;
        case 'watch': {
          const action = interaction.options.getSubcommand();
          if (action === 'add') { const rule = await commands.createWatchRule(userId, json(interaction.options.getString('input'))); message = `Social watch rule **${rule.name}** created with ${rule.method}.`; }
          else if (action === 'edit') { const rule = await commands.updateWatchRule(userId, interaction.options.getString('id'), json(interaction.options.getString('patch'))); message = `Social watch rule **${rule.name}** updated; ${rule.method} adapter selected.`; }
          else if (action === 'disable') { const rule = await commands.disableWatchRule(userId, interaction.options.getString('id')); message = `Social watch rule **${rule.name}** disabled.`; }
          else if (action === 'remove') { confirmation(interaction); const id = await commands.removeWatchRule(userId, interaction.options.getString('id')); message = `Social watch rule ${id} removed.`; }
          else message = formatRows(await commands.watchRules(userId), 'No social watch rules.', rule => `**${rule.name}** [${rule.enabled ? 'enabled' : 'disabled'}] — ${rule.type} via ${rule.method} — ${rule.id}`);
          break;
        }
        case 'social-usage': {
          const summary = await commands.socialUsage(userId, interaction.options.getString('period') || 'month');
          const rows = summary.rows.length ? summary.rows.map(row => `${row.ruleName} | ${row.method}: ${row.requests}`).join('\n') : 'No requests recorded.';
          const tiers = summary.breakEvenRequests.map(tier => `$${tier.price}/mo: ~${tier.atReadRate.toLocaleString('en-US')} reads`).join('\n');
          message = `Social adapter usage (${summary.period})\nTotal: ${summary.requests}\n${rows}\nEstimated pay-per-use: ~$${summary.payPerUseEstimateUsd.toFixed(2)}\nProjected monthly requests: ~${Math.round(summary.projectedMonthlyRequests).toLocaleString('en-US')}\n${tiers}`;
          break;
        }
        default: throw new Error('Unknown Discord command');
      }
      await interaction.editReply(message);
    } catch (error) {
      let message = 'Command failed safely. Please try again.';
      if (error instanceof ValidationError) message = validationReply(error);
      else if (error instanceof AuthorizationError) message = 'Owner access required.';
      else if (error instanceof LinkCodeError || error instanceof ProofResolutionError) message = error.message;
      else log(`Discord command failed: ${error?.message || 'unknown error'}`);
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  };
}

function createDiscordBot({ token, applicationId, devGuildId, identity, commands, log, client, rest }) {
  const discordClient = client || new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
  const api = rest || new REST({ version: '10' }).setToken(token);
  discordClient.on('interactionCreate', createDiscordInteractionHandler({ identity, commands, log }));
  return {
    client: discordClient,
    async start() {
      await api.put(Routes.applicationGuildCommands(applicationId, devGuildId), { body: commandDefinitions() });
      await discordClient.login(token);
      return discordClient.user;
    },
    async sendDirectMessage(platformUserId, message) {
      const user = await discordClient.users.fetch(platformUserId);
      await user.send({ content: message });
    },
    stop() { discordClient.destroy(); },
  };
}

module.exports = { commandDefinitions, createDiscordBot, createDiscordInteractionHandler };
