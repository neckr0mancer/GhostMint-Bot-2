const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { Buffer }  = require('node:buffer');
const { ethers }  = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const { CHAINS, CONFIG, getSafeConfigSummary } = require('./config');
const { createDatabasePool } = require('./db/pool');
const { createIdentityService } = require('./identity/identityService');
const { createPostgresIdentityRepository } = require('./identity/postgresIdentityRepository');
const { findOwnedWallet, stateForUser } = require('./identity/ownership');
const { formatMintPreview } = require('./mint/mintCall');
const { createMintExecutionService } = require('./mint/mintExecutionService');
const { createMintService } = require('./mint/mintService');
const { createPostgresMintPresetRepository } = require('./mint/postgresMintPresetRepository');
const { createProofResolver, ProofResolutionError } = require('./mint/proofResolver');
const { createSchedulerRepository } = require('./scheduler/schedulerRepository');
const { createSchedulerWorker } = require('./scheduler/schedulerWorker');
const { createSniperRepository } = require('./sniper/sniperRepository');
const { createSniperService } = require('./sniper/sniperService');
const { createAdminCommandService } = require('./governance/adminCommandService');
const { AuthorizationError, createGovernanceService } = require('./governance/governanceService');
const { createPostgresGovernanceRepository } = require('./governance/postgresGovernanceRepository');
const { createKeyEncryption } = require('./security/keyEncryption');
const { createRedactor } = require('./security/redaction');
const { createPostgresStorage } = require('./storage/postgresStorage');
const { createTransactionIntentRepository } = require('./transactions/intentRepository');
const { createTransactionPolicyRepository } = require('./transactions/policyRepository');
const { createProviderService } = require('./transactions/providerService');
const { createTransactionEngine } = require('./transactions/transactionEngine');
const { ValidationError, requestSchemas, validationReply } = require('./validation/domain');

// ── Config ────────────────────────────────────────────────
const PORT         = CONFIG.port;
const BOT_TOKEN    = CONFIG.botToken;
const PROJECT_ROOT = CONFIG.projectRoot;

// ── Data ──────────────────────────────────────────────────
const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
const storage = createPostgresStorage(pool);
const identityRepository = createPostgresIdentityRepository(pool);
const identity = createIdentityService(identityRepository);
const transactionIntentRepository = createTransactionIntentRepository(pool);
const schedulerRepository = createSchedulerRepository(pool);
const sniperRepository = createSniperRepository(pool);
const mintPresetRepository = createPostgresMintPresetRepository(pool);
const mintService = createMintService({
  presetRepository: mintPresetRepository,
  proofResolver: createProofResolver(),
  supportedChains: CONFIG.supportedChains,
});
const governanceRepository = createPostgresGovernanceRepository(pool);
const governance = createGovernanceService(governanceRepository);
const adminCommands = createAdminCommandService(governance);
const transactionPolicyRepository = createTransactionPolicyRepository(pool, { governanceRepository });
const providerService = createProviderService({
  chains: CHAINS,
  timeoutMs: CONFIG.rpcTimeoutMs,
  retries: CONFIG.rpcRetries,
});
let DB = { wallets:[], tasks:[], activity:[], pnl:[], snipers:[] };

// ── Crypto ────────────────────────────────────────────────
const keyEncryption = createKeyEncryption({
  activeVersion: CONFIG.encryptionKeyVersion,
  keys: CONFIG.encryptionKeys,
});
const encryptPK = privateKey => keyEncryption.encrypt(privateKey);
const decryptPK = wallet => keyEncryption.decrypt(wallet.keyEnvelope);

// ── Logger ────────────────────────────────────────────────
const redact = createRedactor([
  CONFIG.botToken,
  ...Object.values(CONFIG.encryptionKeys),
]);
const log = msg => console.log(`[${new Date().toISOString()}] ${redact(msg)}`);
const safeError = error => redact(error?.reason || error?.message || 'Unknown error');
log(`Configuration loaded: ${JSON.stringify(getSafeConfigSummary())}`);
const transactionEngine = createTransactionEngine({
  providerService,
  intentRepository: transactionIntentRepository,
  policyRepository: transactionPolicyRepository,
  decryptPrivateKey: decryptPK,
  notify: event => log(`Transaction ${event.intent.intentId} is ${event.state}`),
});
const mintExecution = createMintExecutionService({ mintService, transactionEngine });
const schedulerWorker = createSchedulerWorker({
  repository: schedulerRepository,
  intentRepository: transactionIntentRepository,
  transactionEngine,
  executeTask: async (task, hooks) => {
    const wallet = DB.wallets.find(item => item.userId === task.userId && item.label === task.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const request = requestSchemas.mint({ walletLabel:wallet.label, contractAddress:task.contract,
      functionName:task.fn || 'mint', quantity:task.qty, priceETH:task.price || 0,
      gasGwei:task.gas, chain:wallet.chain }, { supportedChains:CONFIG.supportedChains });
    const prepared = await mintService.prepare({ contractAddress:request.contractAddress,
      methodSignature:'mint(uint256)', arguments:[request.quantity], walletAddress:wallet.address,
      valueWei:ethers.parseEther(String(request.priceETH)) * BigInt(request.quantity), chain:request.chain });
    return mintExecution.executePrepared({ userId:task.userId, wallet, prepared, triggerSource:'scheduled',
      gasPriceWei:request.gasGwei === null ? undefined : ethers.parseUnits(String(request.gasGwei), 'gwei'),
      idempotencyKey:hooks.idempotencyKey, onIntentPersisted:hooks.onIntentPersisted,
      onPreview:preview => notifyUser(task.userId, formatMintPreview(preview)) });
  },
  notify: async event => {
    const wallet = DB.wallets.find(item => item.userId === event.task.userId && item.label === event.task.walletLabel);
    if (event.outcome === 'success') {
      if (wallet) {
        wallet.minted = (wallet.minted || 0) + event.task.qty;
        await storage.updateWalletMinted(event.task.userId, wallet.label, wallet.minted);
        await logActivity(event.task.userId, 'success', `Scheduled mint: ${event.task.name}`, wallet.label,
          event.intent?.txHash || null, CHAINS[wallet.chain]);
      }
      await notifyUser(event.task.userId, `✅ Scheduled mint *${event.task.name}* confirmed.`);
    }
    if (['failure','failed'].includes(event.outcome)) {
      if (wallet) await logActivity(event.task.userId, 'fail', `Scheduled mint failed: ${event.task.name}`,
        wallet.label, event.intent?.txHash || null, CHAINS[wallet.chain]);
      await notifyUser(event.task.userId, `❌ Scheduled mint *${event.task.name}* failed.`);
    }
  },
  log,
  sanitizeError:safeError,
});

// ── Activity ──────────────────────────────────────────────
async function logActivity(userId, status, title, walletLabel, txHash, chain) {
  const entry = await storage.addActivity({ userId, status, title, walletLabel, txHash, explorer: chain?.ex, time: Date.now() });
  DB.activity.unshift(entry);
  if (DB.activity.length > 200) DB.activity.pop();
}

// ── Helpers ───────────────────────────────────────────────
function fmtCD(ms) {
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
  return d>0?`${d}d ${h%24}h`:h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`;
}

function commandJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new ValidationError({ field:'command', message:'must contain a valid JSON object' }); }
}

function previewQuantity(preview) {
  const value = preview.arguments.find(argument => ['quantity', 'amount'].includes(argument.name))?.value;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

// ── Mint executor ─────────────────────────────────────────
async function executePreparedMint({ wallet, prepared, chain, triggerSource='manual', gasGwei=null, onPreview }) {
  if (chain !== prepared.chain) throw new Error('Prepared mint chain mismatch');
  const intent = await mintExecution.executePrepared({ userId: wallet.userId, wallet, prepared, triggerSource,
    gasPriceWei: gasGwei === null ? undefined : ethers.parseUnits(String(gasGwei), 'gwei'), onPreview });
  if (intent.state !== 'confirmed') throw new Error(`Transaction ended in ${intent.state} state`);
  log(`Confirmed: ${intent.txHash} (block ${intent.blockNumber})`);
  return intent.txHash;
}

async function executeMint({ wallet, contractAddr, fnName='mint', qty=1, priceETH=0, gasGwei=null, chain, triggerSource='manual', onPreview }) {
  const request = requestSchemas.mint({
    walletLabel: wallet.label,
    contractAddress: contractAddr,
    functionName: fnName,
    quantity: qty,
    priceETH,
    gasGwei,
    chain,
  }, { supportedChains: CONFIG.supportedChains });
  const prepared = await mintService.prepare({
    contractAddress: request.contractAddress,
    methodSignature: 'mint(uint256)',
    arguments: [request.quantity],
    walletAddress: wallet.address,
    valueWei: ethers.parseEther(String(request.priceETH)) * BigInt(request.quantity),
    chain: request.chain,
  });
  return executePreparedMint({ wallet, prepared, chain: request.chain, triggerSource,
    gasGwei: request.gasGwei, onPreview });
}

// ── Wallet Sniper / Copy-Mint Engine ─────────────────────────
// Watches a target wallet block-by-block and, when it sees the
// target call a contract (typically a mint), replicates that exact
// call — same contract, same calldata — from one of your own
// wallets. Detection happens once the target's tx is confirmed in
// a block, so this is a best-effort copier riding public RPCs, not
// a mempool front-runner.
const sniperProviders = {};
const sniperService = createSniperService({
  repository:sniperRepository,
  intentRepository:transactionIntentRepository,
  transactionEngine,
  supportedChains:CONFIG.supportedChains,
  onEvent:async ({ event, state, reason, intent, error }) => {
    const sniper = DB.snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
    if (!sniper) return;
    const wallet = DB.wallets.find(item => item.userId === sniper.userId && item.label === sniper.walletLabel);
    if (state === 'confirmed') {
      sniper.hits = (sniper.hits || 0) + 1;
      sniper.lastFiredAt = Date.now();
      if (wallet) wallet.minted = (wallet.minted || 0) + 1;
      await Promise.all([storage.saveSniper(sniper), wallet
        ? storage.updateWalletMinted(sniper.userId, wallet.label, wallet.minted) : Promise.resolve()]);
      if (wallet) await logActivity(sniper.userId, 'success', `Post-confirmation copy-mint (${sniper.label})`,
        wallet.label, intent?.txHash || null, CHAINS[sniper.chain]);
    } else if (state === 'failed') {
      sniper.fails = (sniper.fails || 0) + 1;
      await storage.saveSniper(sniper);
    }
    await notifyUser(sniper.userId, state === 'confirmed'
      ? `✅ Post-confirmation copy *${sniper.label}* confirmed.`
      : `🎯 Post-confirmation copy *${sniper.label}*: ${state}${reason ? ` — ${reason}` : ''}${error ? ` — ${safeError(error).slice(0,120)}` : ''}`);
  },
});

const activeSnipersForChain = chain => DB.snipers.filter(s => s.active && s.chain === chain);

function ensureChainWatcher(chain) {
  if (sniperProviders[chain] || !CHAINS[chain]) return;
  const provider = new ethers.JsonRpcProvider(CHAINS[chain].rpc);
  provider.pollingInterval = 2500;
  sniperProviders[chain] = provider;
  provider.on('block', bn => onBlock(chain, bn).catch(e => log(`Sniper block err (${chain}): ${safeError(e)}`)));
  log(`🎯 Sniper watcher started on ${CHAINS[chain].name}`);
}

function teardownChainWatcherIfIdle(chain) {
  if (activeSnipersForChain(chain).length) return;
  const provider = sniperProviders[chain];
  if (!provider) return;
  provider.removeAllListeners();
  provider.destroy?.();
  delete sniperProviders[chain];
  log(`🎯 Sniper watcher stopped on ${chain} (no active targets)`);
}

async function onBlock(chain, blockNumber) {
  const snipers = activeSnipersForChain(chain);
  if (!snipers.length) return;
  const provider = sniperProviders[chain];
  const block = await provider.getBlock(blockNumber, true);
  if (!block?.prefetchedTransactions) return;
  for (const tx of block.prefetchedTransactions) {
    if (!tx.to || !tx.data || tx.data === '0x') continue; // skip plain transfers / contract creations
    for (const sniper of snipers) {
      try {
        if (tx.from.toLowerCase() !== sniper.targetAddress.toLowerCase()) continue;
        await sniperService.detect(sniper, { hash:tx.hash, to:tx.to, blockNumber, blockHash:block.hash });
      } catch (error) { log(`Sniper ${sniper.id} detection failed: ${safeError(error)}`); }
    }
  }
  await sniperService.processBlock(chain, blockNumber, snipers,
    hash => provider.getTransaction(hash),
    hash => provider.getTransactionReceipt(hash),
    sniper => DB.wallets.find(wallet => wallet.userId === sniper.userId && wallet.label === sniper.walletLabel));
}

// ── Telegram ──────────────────────────────────────────────
let bot = null;
function tg(chatId, msg) {
  if (bot && chatId) return bot.sendMessage(chatId, msg, { parse_mode:'Markdown' }).catch(e => log('TG: '+safeError(e)));
  return Promise.resolve();
}

async function notifyUser(userId, msg) {
  const telegramId = await identityRepository.getLinkedAccount(userId, 'telegram');
  if (telegramId) tg(telegramId, msg);
}

function stateFor(userId) {
  return stateForUser(DB, userId);
}

function withTelegramUser(handler) {
  return async (msg, match) => {
    try {
      const userId = await identity.resolveOrCreate('telegram', msg.from.id);
      await handler(msg, match, userId);
    } catch (error) {
      if (error instanceof ValidationError) {
        tg(msg.chat.id, validationReply(error));
        return;
      }
      if (error instanceof AuthorizationError) {
        tg(msg.chat.id, '❌ Owner access required.');
        return;
      }
      if (error instanceof ProofResolutionError) {
        tg(msg.chat.id, `❌ ${error.message}`);
        return;
      }
      log(`Telegram command failed: ${safeError(error)}`);
      tg(msg.chat.id, 'Command failed safely. Please try again.');
    }
  };
}

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  log('Telegram bot started');
  bot.on('message', msg => {
    if (msg.text?.startsWith('/') && msg.from?.id) {
      identity.resolveOrCreate('telegram', msg.from.id)
        .catch(error => log(`Telegram identity resolution failed: ${safeError(error)}`));
    }
  });

  bot.onText(/^\/(?:start|help)(?:@\w+)?$/, withTelegramUser(async msg => {
    tg(msg.chat.id, `👻 *GhostMint Bot*\n\n*Commands:*\n/wallets — list wallets\n/tasks — scheduled tasks\n/snipers — post-confirmation copy watchers\n/updatesniper <id> <JSON> — update copy limits\n/activity — recent mints\n/gas — live gas prices\n/stats — overview\n/link — create a 5-minute account-link code\n/mode <preset> — select a transaction mode\n/admin <action> — owner-only governance\n/mintcall <JSON> — flexible supported-signature mint\n/mintpreset save|use|delete <JSON/name>\n/mintpresets — list saved mint presets\n/canceltask <id> — cancel task\n/pausetask <id> — pause task\n/resumetask <id> — resume task\n/retrytask <id> — retry failed task\n/removewallet <label> — remove wallet\n/mintnow <label> <contract> <qty> <price> <chain> — legacy quantity mint`);
  }));

  bot.onText(/^\/link(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const link = await identity.createLinkCode(userId);
    tg(msg.chat.id, `🔗 *Account link code:* \`${link.code}\`\n\nExpires in 5 minutes and can be used once.`);
  }));

  bot.onText(/^\/mode(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const selected = await governance.selectPreset(userId, match[1]);
    tg(msg.chat.id, `✅ Transaction mode set to *${selected.replaceAll('_', ' ')}*.`);
  }));

  bot.onText(/^\/admin(?:@\w+)?(?:\s+(.*))?$/, withTelegramUser(async (msg, match, userId) => {
    tg(msg.chat.id, await adminCommands.execute(userId, match[1]));
  }));

  async function runFlexibleMint(msg, userId, payload, manualAuthorization) {
    const wallet = findOwnedWallet(DB, userId, payload.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const prepared = await mintService.prepare({
      contractAddress: payload.contractAddress,
      methodSignature: payload.methodSignature,
      arguments: payload.arguments || [],
      manualAuthorization,
      proofUrl: payload.proofUrl,
      walletAddress: wallet.address,
      valueWei: payload.valueWei ?? '0',
      chain: payload.chain || wallet.chain,
    });
    const txHash = await executePreparedMint({ wallet, prepared, chain: payload.chain || wallet.chain,
      onPreview: preview => tg(msg.chat.id, formatMintPreview(preview), {}) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Minted via ${prepared.method.signature}`, wallet.label, txHash, CHAINS[payload.chain || wallet.chain]);
    await tg(msg.chat.id, `✅ Mint successful.\n${CHAINS[payload.chain || wallet.chain].ex}${txHash}`, {});
  }

  bot.onText(/^\/mintcall(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    await runFlexibleMint(msg, userId, commandJson(match[1]));
  }));

  bot.on('document', withTelegramUser(async (msg, match, userId) => {
    const command = msg.caption?.match(/^\/mintcall(?:@\w+)?\s+(.+)$/s);
    if (!command) return;
    const link = await bot.getFileLink(msg.document.file_id);
    let response;
    try { response = await axios.get(link, { responseType:'arraybuffer', timeout:10_000, maxContentLength:1_000_000 }); }
    catch (error) { throw new ProofResolutionError('The uploaded proof file could not be downloaded.', error); }
    await runFlexibleMint(msg, userId, commandJson(command[1]), Buffer.from(response.data));
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+save\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const payload = commandJson(match[1]);
    const wallet = findOwnedWallet(DB, userId, payload.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const saved = await mintService.savePreset(userId, { ...payload, walletAddress: wallet.address,
      valueWei: payload.valueWei ?? '0', chain: payload.chain || wallet.chain });
    await tg(msg.chat.id, `✅ Mint preset *${saved.name}* saved.`);
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+use\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const payload = commandJson(match[1]);
    const wallet = findOwnedWallet(DB, userId, payload.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const prepared = await mintService.preparePreset(userId, payload.name, wallet.address);
    const txHash = await executePreparedMint({ wallet, prepared, chain: prepared.chain,
      onPreview: preview => tg(msg.chat.id, formatMintPreview(preview), {}) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Preset mint via ${prepared.method.signature}`, wallet.label, txHash, CHAINS[prepared.chain]);
    await tg(msg.chat.id, `✅ Preset mint successful.\n${CHAINS[prepared.chain].ex}${txHash}`, {});
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+delete\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const deleted = await mintService.deletePreset(userId, match[1]);
    await tg(msg.chat.id, deleted ? '✅ Mint preset deleted.' : 'Mint preset not found.');
  }));

  bot.onText(/^\/mintpresets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const presets = await mintService.listPresets(userId);
    await tg(msg.chat.id, presets.length ? presets.map(preset => `• *${preset.name}* — ${preset.methodSignature}`).join('\n') : 'No mint presets saved.');
  }));

  bot.onText(/^\/snipers(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const snipers = stateFor(userId).snipers;
    if (!snipers.length) return tg(msg.chat.id, 'No snipers configured.');
    const list = snipers.map(s =>
      `${s.active?'🟢':'⚪'} *${s.label}*\nTarget: \`${s.targetAddress.slice(0,10)}...\`\nChain: ${CHAINS[s.chain]?.name||s.chain} · Wallet: ${s.walletLabel}\nHits: ${s.hits||0} · Fails: ${s.fails||0}`
    ).join('\n\n');
    tg(msg.chat.id, `🎯 *Post-confirmation copy snipers (${snipers.length})*\n_Not mempool front-running: copying begins only after the source transaction confirms._\n\n${list}`);
  }));

  bot.onText(/^\/updatesniper(?:@\w+)?\s+([0-9a-f-]+)\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.sniperDeletion({ id:match[1] });
    const sniper = DB.snipers.find(item => item.userId === userId && item.id === id);
    if (!sniper) return tg(msg.chat.id, 'Post-confirmation copy sniper not found.');
    const previousChain = sniper.chain;
    const updated = sniperService.validatePatch(sniper, commandJson(match[2]));
    await storage.saveSniper(updated);
    Object.assign(sniper, updated);
    if (sniper.active) ensureChainWatcher(sniper.chain);
    if (previousChain !== sniper.chain || !sniper.active) teardownChainWatcherIfIdle(previousChain);
    tg(msg.chat.id, `✅ Post-confirmation copy sniper *${sniper.label}* updated. This is not mempool front-running.`);
  }));

  bot.onText(/^\/wallets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = stateFor(userId).wallets;
    if (!wallets.length) return tg(msg.chat.id, 'No wallets yet.');
    const list = wallets.map((w,i) =>
      `${i+1}. *${w.label}*\n   \`${w.address.slice(0,6)}...${w.address.slice(-4)}\` · ${CHAINS[w.chain]?.name||w.chain} · minted: ${w.minted||0}`
    ).join('\n\n');
    tg(msg.chat.id, `⬡ *Wallets (${wallets.length})*\n\n${list}`);
  }));

  bot.onText(/^\/tasks(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const pending = await schedulerRepository.listForUser(userId);
    if (!pending.length) return tg(msg.chat.id, 'No scheduled tasks.');
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ *${t.name}* [${t.status}]\nWallet: ${t.walletLabel}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nDue (UTC): *${new Date(t.mintTime).toISOString()}*${ms>0?`\nFires in: *${fmtCD(ms)}*`:''}\nID: \`${t.id}\``;
    }).join('\n\n');
    tg(msg.chat.id, `⏱ *Tasks (${pending.length})*\n\n${list}`);
  }));

  bot.onText(/^\/activity(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const recent = stateFor(userId).activity.slice(0, 10);
    if (!recent.length) return tg(msg.chat.id, 'No activity yet.');
    const list = recent.map(a => {
      const ico = a.status==='success'?'✅':'❌';
      const tx  = a.txHash?`\n   [View tx](${a.explorer}${a.txHash})`:'';
      return `${ico} ${a.title} · *${a.walletLabel}*\n   ${new Date(a.time).toLocaleString()}${tx}`;
    }).join('\n\n');
    tg(msg.chat.id, `📋 *Recent Activity*\n\n${list}`);
  }));

  bot.onText(/^\/gas(?:@\w+)?$/, withTelegramUser(async msg => {
    try {
      const r = await axios.get('https://api.etherscan.io/api?module=gastracker&action=gasoracle');
      const d = r.data.result;
      tg(msg.chat.id, `⛽ *Live Gas (Ethereum)*\n🐢 Slow: *${d.SafeGasPrice}* Gwei\n⚡ Standard: *${d.ProposeGasPrice}* Gwei\n🚀 Fast: *${d.FastGasPrice}* Gwei\nBase fee: ${parseFloat(d.suggestBaseFee).toFixed(2)} Gwei`);
    } catch { tg(msg.chat.id, 'Could not fetch gas prices.'); }
  }));

  bot.onText(/^\/stats(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const state = stateFor(userId);
    const total = state.activity.length;
    const success = state.activity.filter(a => a.status==='success').length;
    const minted = state.wallets.reduce((sum,w) => sum+(w.minted||0), 0);
    const pending = (await schedulerRepository.listForUser(userId)).filter(t => ['scheduled','retry','claimed','paused'].includes(t.status)).length;
    tg(msg.chat.id, `📊 *GhostMint Stats*\n\n⬡ Wallets: *${state.wallets.length}*\n⏱ Pending: *${pending}*\n⚡ Minted: *${minted}*\n✅ Success rate: *${total?Math.round(success/total*100):0}%*\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`);
  }));

  bot.onText(/^\/canceltask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.taskDeletion({ id: match[1] });
    const task = await schedulerRepository.cancel(userId, id);
    tg(msg.chat.id, task ? `✅ Task *${task.name}* cancelled.` : 'Task not found or cannot be cancelled in its current state.');
  }));

  bot.onText(/^\/pausetask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.taskDeletion({ id: match[1] });
    const task = await schedulerRepository.pause(userId, id);
    tg(msg.chat.id, task ? `⏸ Task *${task.name}* paused.` : 'Task not found or cannot be paused in its current state.');
  }));

  bot.onText(/^\/resumetask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.taskDeletion({ id: match[1] });
    const task = await schedulerRepository.resume(userId, id, Date.now());
    tg(msg.chat.id, task ? `▶ Task *${task.name}* resumed.` : 'Task not found or is not paused.');
  }));

  bot.onText(/^\/retrytask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.taskDeletion({ id: match[1] });
    const task = await schedulerRepository.retry(userId, id, Date.now());
    tg(msg.chat.id, task ? `↻ Task *${task.name}* queued for retry.` : 'Task not found or is not failed.');
  }));

  bot.onText(/^\/removewallet(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { label } = requestSchemas.walletDeletion({ label: match[1] });
    const ownedWallet = findOwnedWallet(DB, userId, label);
    if (!ownedWallet) return tg(msg.chat.id, `Wallet "${label}" not found.`);
    const idx = DB.wallets.indexOf(ownedWallet);
    const [removed] = DB.wallets.splice(idx, 1); await storage.deleteWallet(userId, removed.label);
    tg(msg.chat.id, `✅ Wallet *${label}* removed.`);
  }));

  bot.onText(/^\/mintnow(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) return tg(msg.chat.id, 'Usage: /mintnow <label> <contract> [qty] [price] [chain]');
    const [label, contract, qtyRaw, priceRaw, chainRaw] = parts;
    const wallet = findOwnedWallet(DB, userId, label);
    if (!wallet) return tg(msg.chat.id, `Wallet "${label}" not found. Use /wallets.`);
    const request = requestSchemas.mint({
      walletLabel: wallet.label,
      contractAddress: contract,
      quantity: qtyRaw === undefined ? 1 : qtyRaw,
      priceETH: priceRaw === undefined ? 0 : priceRaw,
      chain: chainRaw === undefined ? wallet.chain : chainRaw,
    }, { supportedChains: CONFIG.supportedChains });
    const { quantity: qty, priceETH: price, chain: ch } = request;
    tg(msg.chat.id, `⚡ Minting from *${wallet.label}*...\nContract: \`${request.contractAddress.slice(0,10)}...\`\nQty: ${qty} | Price: ${price>0?price+' ETH':'Free'}`);
    try {
      const txHash = await executeMint({ wallet, contractAddr:request.contractAddress, fnName:'mint', qty, priceETH:price, chain:ch,
        onPreview: preview => tg(msg.chat.id, formatMintPreview(preview), {}) });
      wallet.minted=(wallet.minted||0)+qty;
      await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
      await logActivity(userId, 'success',`Minted ${qty} NFT${qty>1?'s':''}`,wallet.label,txHash,CHAINS[ch]);
      tg(msg.chat.id, `✅ *Mint successful!*\nWallet: *${wallet.label}*\nQty: ${qty}\n[View tx](${CHAINS[ch].ex}${txHash})`);
    } catch(e) {
      await logActivity(userId, 'fail','Mint failed',wallet.label,null,CHAINS[ch]);
      tg(msg.chat.id, `❌ *Mint failed*\n${safeError(e).slice(0,120)}`);
    }
  }));
} else {
  log('⚠️  No TELEGRAM_BOT_TOKEN — Telegram disabled.');
}

// ── Task Scheduler ────────────────────────────────────────
// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT,'public')));

function dashboardUnavailable(req, res) {
  res.status(501).json({ error:'Dashboard identity is unavailable until Milestone 13' });
}
app.use('/api', dashboardUnavailable);

// ── API ───────────────────────────────────────────────────
app.get('/health', async (req,res) => {
  try {
    await storage.health();
    res.json({ status:'ok', database:'connected', uptime:Math.floor(process.uptime()), tasks:await schedulerRepository.countActive() });
  } catch {
    res.status(503).json({ status:'degraded', database:'disconnected', uptime:Math.floor(process.uptime()) });
  }
});
app.get('*', (req,res) => res.sendFile(path.join(PROJECT_ROOT,'public','index.html')));

// ── Start ─────────────────────────────────────────────────
async function start() {
  DB = await storage.loadSystemState();
  const reconciled = await transactionEngine.reconcileNonFinal();
  log(`Reconciled ${reconciled.length} non-final transaction intents`);
  const recovered = await schedulerWorker.recoverStaleClaims();
  log(`Recovered ${recovered} expired scheduler claims`);
  schedulerWorker.start();
  log(`Started durable scheduler with ${await schedulerRepository.countActive()} active tasks`);
  DB.snipers.filter(s => s.active).forEach(s => ensureChainWatcher(s.chain));
  log(`Restored ${DB.snipers.filter(s=>s.active).length} active snipers`);
  app.listen(PORT, () => {
    log(`GhostMint running on port ${PORT}`);
    log(`Wallets: ${DB.wallets.length} | Tasks: ${DB.tasks.length}`);
  });
}

start().catch(error => {
  log(`Startup failed: ${safeError(error)}`);
  process.exitCode = 1;
});

process.on('unhandledRejection', e => log('Rejection: '+safeError(e)));
process.on('uncaughtException',  e => log('Exception: '+safeError(e)));
