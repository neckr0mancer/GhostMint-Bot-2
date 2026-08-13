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
const { findOwnedTask, findOwnedWallet, stateForUser } = require('./identity/ownership');
const { formatMintPreview } = require('./mint/mintCall');
const { createMintExecutionService } = require('./mint/mintExecutionService');
const { createMintService } = require('./mint/mintService');
const { createPostgresMintPresetRepository } = require('./mint/postgresMintPresetRepository');
const { createProofResolver, ProofResolutionError } = require('./mint/proofResolver');
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
const { MAX_SCHEDULE_AHEAD_MS, ValidationError, requestSchemas, validationReply } = require('./validation/domain');

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
const sniperProviders = {};  // chain -> ethers provider, only live while a sniper is active on it
const sniperSeenTx     = {}; // sniperId -> Set of already-handled tx hashes (capped)

const sniperKey = sniper => `${sniper.userId}:${sniper.id}`;

async function markSeen(sniper, hash) {
  const key = sniperKey(sniper);
  if (!sniperSeenTx[key]) sniperSeenTx[key] = new Set();
  const set = sniperSeenTx[key];
  set.add(hash);
  if (set.size > 500) set.delete(set.values().next().value);
  await storage.markSeenTransaction(sniper.userId, sniper.id, hash);
}
const alreadySeen = async (sniper, hash) => sniperSeenTx[sniperKey(sniper)]?.has(hash)
  || storage.hasSeenTransaction(sniper.userId, sniper.id, hash);

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
      if (tx.from.toLowerCase() !== sniper.targetAddress.toLowerCase()) continue;
      if (await alreadySeen(sniper, tx.hash)) continue;
      await markSeen(sniper, tx.hash);
      fireSnipe(sniper, tx, chain).catch(e => log(`Snipe fire error: ${safeError(e)}`));
    }
  }
}

async function fireSnipe(sniper, targetTx, chain) {
  const chainCfg = CHAINS[chain];
  const wallet   = DB.wallets.find(w => w.userId === sniper.userId && w.label === sniper.walletLabel);
  if (!wallet) { await notifyUser(sniper.userId, `❌ *Sniper "${sniper.label}" failed*\nFiring wallet "${sniper.walletLabel}" not found.`); return; }

  let value = targetTx.value ?? 0n;
  if (sniper.valueMode === 'fixed') value = ethers.parseEther(String(sniper.fixedValueETH || 0));
  if (sniper.maxValueETH != null) {
    const cap = ethers.parseEther(String(sniper.maxValueETH));
    if (value > cap) {
      await logActivity(sniper.userId, 'fail', `Sniper skipped (value ${ethers.formatEther(value)} ETH > cap)`, wallet.label, null, chainCfg);
      await notifyUser(sniper.userId, `⚠️ *Sniper "${sniper.label}" skipped*\nTarget tx wants ${ethers.formatEther(value)} ETH, over your ${sniper.maxValueETH} ETH cap.`);
      return;
    }
  }

  await notifyUser(sniper.userId, `🎯 *Target minting detected!*\nSniper: *${sniper.label}*\nTarget: \`${sniper.targetAddress.slice(0,8)}...\`\nCopying with wallet *${wallet.label}*...`);

  try {
    const boostBp = BigInt(100 + (sniper.gasBoostPercent ?? 20)); // e.g. 120 = +20%
    const feeOverrides = {};
    if (targetTx.maxFeePerGas) {
      feeOverrides.maxFeePerGasWei         = (targetTx.maxFeePerGas * boostBp) / 100n;
      feeOverrides.maxPriorityFeePerGasWei = ((targetTx.maxPriorityFeePerGas || targetTx.maxFeePerGas) * boostBp) / 100n;
    } else if (targetTx.gasPrice) {
      feeOverrides.gasPriceWei = (targetTx.gasPrice * boostBp) / 100n;
    }
    const intent = await transactionEngine.submit({
      userId: sniper.userId,
      wallet,
      targetId: sniper.id,
      chain,
      triggerSource: 'blockchain',
      to: targetTx.to,
      data: targetTx.data,
      valueWei: value,
      ...feeOverrides,
    });
    if (intent.state !== 'confirmed') throw new Error(`Transaction ended in ${intent.state} state`);
    wallet.minted = (wallet.minted || 0) + 1;
    sniper.hits = (sniper.hits || 0) + 1;
    sniper.lastFiredAt = Date.now();
    await Promise.all([
      storage.updateWalletMinted(sniper.userId, wallet.label, wallet.minted),
      storage.saveSniper(sniper),
    ]);
    await logActivity(sniper.userId, 'success', `Sniper copy-mint (${sniper.label})`, wallet.label, intent.txHash, chainCfg);
    await notifyUser(sniper.userId, `✅ *Snipe successful!*\nSniper: *${sniper.label}*\nWallet: *${wallet.label}*\n[View tx](${chainCfg.ex}${intent.txHash})`);
  } catch (e) {
    sniper.fails = (sniper.fails || 0) + 1;
    await storage.saveSniper(sniper);
    await logActivity(sniper.userId, 'fail', `Sniper copy-mint failed (${sniper.label})`, wallet.label, null, chainCfg);
    await notifyUser(sniper.userId, `❌ *Snipe failed*\nSniper: *${sniper.label}*\nError: ${safeError(e).slice(0,150)}`);
  }
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
    tg(msg.chat.id, `👻 *GhostMint Bot*\n\n*Commands:*\n/wallets — list wallets\n/tasks — scheduled tasks\n/snipers — copy-mint watchers\n/activity — recent mints\n/gas — live gas prices\n/stats — overview\n/link — create a 5-minute account-link code\n/mode <preset> — select a transaction mode\n/admin <action> — owner-only governance\n/mintcall <JSON> — flexible supported-signature mint\n/mintpreset save|use|delete <JSON/name>\n/mintpresets — list saved mint presets\n/canceltask <id> — cancel task\n/removewallet <label> — remove wallet\n/mintnow <label> <contract> <qty> <price> <chain> — legacy quantity mint`);
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
    tg(msg.chat.id, `🎯 *Snipers (${snipers.length})*\n\n${list}`);
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
    const pending = stateFor(userId).tasks.filter(t => t.status === 'waiting');
    if (!pending.length) return tg(msg.chat.id, 'No scheduled tasks.');
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ *${t.name}*\nWallet: ${t.walletLabel}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nFires in: *${ms>0?fmtCD(ms):'NOW'}*\nID: \`${t.id}\``;
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
    const pending = state.tasks.filter(t => t.status==='waiting').length;
    tg(msg.chat.id, `📊 *GhostMint Stats*\n\n⬡ Wallets: *${state.wallets.length}*\n⏱ Pending: *${pending}*\n⚡ Minted: *${minted}*\n✅ Success rate: *${total?Math.round(success/total*100):0}%*\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`);
  }));

  bot.onText(/^\/canceltask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const { id } = requestSchemas.taskDeletion({ id: match[1] });
    const ownedTask = findOwnedTask(DB, userId, id);
    if (!ownedTask) return tg(msg.chat.id, 'Task not found. Use /tasks to see IDs.');
    const idx = DB.tasks.indexOf(ownedTask);
    const name = ownedTask.name;
    DB.tasks.splice(idx, 1); await storage.deleteTask(userId, id);
    const key = taskKey({ userId, id });
    if (taskTimers[key]) { clearTimeout(taskTimers[key]); delete taskTimers[key]; }
    tg(msg.chat.id, `✅ Task *${name}* cancelled.`);
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
const taskTimers = {};
const taskKey = task => `${task.userId}:${task.id}`;

function scheduleTask(task) {
  const key = taskKey(task);
  if (taskTimers[key]) clearTimeout(taskTimers[key]);
  const ms = task.mintTime - Date.now();
  if (ms <= 0) return;
  if (!Number.isFinite(ms) || ms > MAX_SCHEDULE_AHEAD_MS) {
    log(`Task "${task.name}" not scheduled: mint time is outside the safe timer range`);
    return;
  }
  log(`Task "${task.name}" fires in ${fmtCD(ms)}`);
  taskTimers[key] = setTimeout(() => fireTask(task), ms);
}

async function fireTask(task) {
  log(`Firing: ${task.name}`);
  const wallet = DB.wallets.find(w => w.userId===task.userId && w.label===task.walletLabel);
  if (!wallet) {
    task.status='failed'; await storage.saveTask(task);
    await notifyUser(task.userId, `❌ *Task failed: ${task.name}*\nWallet "${task.walletLabel}" not found.`);
    return;
  }
  task.status='running'; await storage.saveTask(task);
  await notifyUser(task.userId, `⚡ *Auto-minting!*\nTask: *${task.name}*\nWallet: *${wallet.label}*\nQty: ${task.qty}`);
  try {
    const txHash = await executeMint({ wallet, contractAddr:task.contract, fnName:task.fn||'mint', qty:task.qty, priceETH:task.price||0, gasGwei:task.gas||null, chain:wallet.chain, triggerSource:'scheduled',
      onPreview: preview => notifyUser(task.userId, formatMintPreview(preview)) });
    task.status='done'; wallet.minted=(wallet.minted||0)+task.qty;
    await Promise.all([storage.saveTask(task), storage.updateWalletMinted(task.userId, wallet.label, wallet.minted)]);
    await logActivity(task.userId, 'success',`Auto-minted ${task.qty} NFT${task.qty>1?'s':''}`,wallet.label,txHash,CHAINS[wallet.chain]);
    await notifyUser(task.userId, `✅ *Auto-mint SUCCESS!*\nTask: *${task.name}*\nWallet: *${wallet.label}*\nQty: ${task.qty}\n[View tx](${CHAINS[wallet.chain].ex}${txHash})`);
  } catch(e) {
    task.status='failed'; await storage.saveTask(task);
    await logActivity(task.userId, 'fail',`Auto-mint failed: ${task.name}`,wallet.label,null,CHAINS[wallet.chain]);
    await notifyUser(task.userId, `❌ *Auto-mint FAILED*\nTask: *${task.name}*\nError: ${safeError(e).slice(0,120)}`);
    log(`Task failed: ${safeError(e)}`);
  }
}

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
    res.json({ status:'ok', database:'connected', uptime:Math.floor(process.uptime()), tasks:DB.tasks.filter(t=>t.status==='waiting').length });
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
  DB.tasks.filter(t => t.status==='waiting' && t.mintTime>Date.now()).forEach(scheduleTask);
  log(`Restored ${DB.tasks.filter(t=>t.status==='waiting').length} pending tasks`);
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
