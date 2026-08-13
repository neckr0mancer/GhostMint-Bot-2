const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { ethers }  = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const { CHAINS, CONFIG, getSafeConfigSummary } = require('./config');
const { createDatabasePool } = require('./db/pool');
const { createIdentityService } = require('./identity/identityService');
const { createPostgresIdentityRepository } = require('./identity/postgresIdentityRepository');
const { findOwnedTask, findOwnedWallet, stateForUser } = require('./identity/ownership');
const { createKeyEncryption } = require('./security/keyEncryption');
const { createRedactor } = require('./security/redaction');
const { createPostgresStorage } = require('./storage/postgresStorage');

// ── Config ────────────────────────────────────────────────
const PORT         = CONFIG.port;
const BOT_TOKEN    = CONFIG.botToken;
const PROJECT_ROOT = CONFIG.projectRoot;

// ── Data ──────────────────────────────────────────────────
const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
const storage = createPostgresStorage(pool);
const identityRepository = createPostgresIdentityRepository(pool);
const identity = createIdentityService(identityRepository);
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

// ── Mint executor ─────────────────────────────────────────
async function executeMint({ wallet, contractAddr, fnName='mint', qty=1, priceETH=0, gasGwei=null, chain }) {
  const chainCfg = CHAINS[chain] || CHAINS.ethereum;
  const pk       = decryptPK(wallet);
  const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
  const signer   = new ethers.Wallet(pk, provider);
  const abi = [{inputs:[{name:'quantity',type:'uint256'}],name:fnName,outputs:[],stateMutability:'payable',type:'function'}];
  const contract  = new ethers.Contract(contractAddr, abi, signer);
  const value     = ethers.parseEther((priceETH * qty).toString());
  const overrides = { value };
  if (gasGwei) overrides.gasPrice = ethers.parseUnits(gasGwei.toString(), 'gwei');
  const tx = await contract[fnName](qty, overrides);
  log(`Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`Confirmed: ${tx.hash} (block ${receipt.blockNumber})`);
  return tx.hash;
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
    const pk       = decryptPK(wallet);
    const provider = sniperProviders[chain] || new ethers.JsonRpcProvider(chainCfg.rpc);
    const signer   = new ethers.Wallet(pk, provider);
    const overrides = { to: targetTx.to, data: targetTx.data, value };

    const boostBp = BigInt(100 + (sniper.gasBoostPercent ?? 20)); // e.g. 120 = +20%
    if (targetTx.maxFeePerGas) {
      overrides.maxFeePerGas         = (targetTx.maxFeePerGas * boostBp) / 100n;
      overrides.maxPriorityFeePerGas = ((targetTx.maxPriorityFeePerGas || targetTx.maxFeePerGas) * boostBp) / 100n;
    } else if (targetTx.gasPrice) {
      overrides.gasPrice = (targetTx.gasPrice * boostBp) / 100n;
    }

    const tx = await signer.sendTransaction(overrides);
    log(`Sniper tx sent: ${tx.hash}`);
    await tx.wait();
    wallet.minted = (wallet.minted || 0) + 1;
    sniper.hits = (sniper.hits || 0) + 1;
    sniper.lastFiredAt = Date.now();
    await Promise.all([
      storage.updateWalletMinted(sniper.userId, wallet.label, wallet.minted),
      storage.saveSniper(sniper),
    ]);
    await logActivity(sniper.userId, 'success', `Sniper copy-mint (${sniper.label})`, wallet.label, tx.hash, chainCfg);
    await notifyUser(sniper.userId, `✅ *Snipe successful!*\nSniper: *${sniper.label}*\nWallet: *${wallet.label}*\n[View tx](${chainCfg.ex}${tx.hash})`);
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
  if (bot && chatId) bot.sendMessage(chatId, msg, { parse_mode:'Markdown' }).catch(e => log('TG: '+safeError(e)));
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

  bot.onText(/\/start|\/help/, withTelegramUser(async msg => {
    tg(msg.chat.id, `👻 *GhostMint Bot*\n\n*Commands:*\n/wallets — list wallets\n/tasks — scheduled tasks\n/snipers — copy-mint watchers\n/activity — recent mints\n/gas — live gas prices\n/stats — overview\n/link — create a 5-minute account-link code\n/canceltask <id> — cancel task\n/removewallet <label> — remove wallet\n/mintnow <label> <contract> <qty> <price> <chain> — instant mint`);
  }));

  bot.onText(/\/link$/, withTelegramUser(async (msg, match, userId) => {
    const link = await identity.createLinkCode(userId);
    tg(msg.chat.id, `🔗 *Account link code:* \`${link.code}\`\n\nExpires in 5 minutes and can be used once.`);
  }));

  bot.onText(/\/snipers/, withTelegramUser(async (msg, match, userId) => {
    const snipers = stateFor(userId).snipers;
    if (!snipers.length) return tg(msg.chat.id, 'No snipers configured.');
    const list = snipers.map(s =>
      `${s.active?'🟢':'⚪'} *${s.label}*\nTarget: \`${s.targetAddress.slice(0,10)}...\`\nChain: ${CHAINS[s.chain]?.name||s.chain} · Wallet: ${s.walletLabel}\nHits: ${s.hits||0} · Fails: ${s.fails||0}`
    ).join('\n\n');
    tg(msg.chat.id, `🎯 *Snipers (${snipers.length})*\n\n${list}`);
  }));

  bot.onText(/\/wallets/, withTelegramUser(async (msg, match, userId) => {
    const wallets = stateFor(userId).wallets;
    if (!wallets.length) return tg(msg.chat.id, 'No wallets yet.');
    const list = wallets.map((w,i) =>
      `${i+1}. *${w.label}*\n   \`${w.address.slice(0,6)}...${w.address.slice(-4)}\` · ${CHAINS[w.chain]?.name||w.chain} · minted: ${w.minted||0}`
    ).join('\n\n');
    tg(msg.chat.id, `⬡ *Wallets (${wallets.length})*\n\n${list}`);
  }));

  bot.onText(/\/tasks/, withTelegramUser(async (msg, match, userId) => {
    const pending = stateFor(userId).tasks.filter(t => t.status === 'waiting');
    if (!pending.length) return tg(msg.chat.id, 'No scheduled tasks.');
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ *${t.name}*\nWallet: ${t.walletLabel}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nFires in: *${ms>0?fmtCD(ms):'NOW'}*\nID: \`${t.id}\``;
    }).join('\n\n');
    tg(msg.chat.id, `⏱ *Tasks (${pending.length})*\n\n${list}`);
  }));

  bot.onText(/\/activity/, withTelegramUser(async (msg, match, userId) => {
    const recent = stateFor(userId).activity.slice(0, 10);
    if (!recent.length) return tg(msg.chat.id, 'No activity yet.');
    const list = recent.map(a => {
      const ico = a.status==='success'?'✅':'❌';
      const tx  = a.txHash?`\n   [View tx](${a.explorer}${a.txHash})`:'';
      return `${ico} ${a.title} · *${a.walletLabel}*\n   ${new Date(a.time).toLocaleString()}${tx}`;
    }).join('\n\n');
    tg(msg.chat.id, `📋 *Recent Activity*\n\n${list}`);
  }));

  bot.onText(/\/gas/, withTelegramUser(async msg => {
    try {
      const r = await axios.get('https://api.etherscan.io/api?module=gastracker&action=gasoracle');
      const d = r.data.result;
      tg(msg.chat.id, `⛽ *Live Gas (Ethereum)*\n🐢 Slow: *${d.SafeGasPrice}* Gwei\n⚡ Standard: *${d.ProposeGasPrice}* Gwei\n🚀 Fast: *${d.FastGasPrice}* Gwei\nBase fee: ${parseFloat(d.suggestBaseFee).toFixed(2)} Gwei`);
    } catch { tg(msg.chat.id, 'Could not fetch gas prices.'); }
  }));

  bot.onText(/\/stats/, withTelegramUser(async (msg, match, userId) => {
    const state = stateFor(userId);
    const total = state.activity.length;
    const success = state.activity.filter(a => a.status==='success').length;
    const minted = state.wallets.reduce((sum,w) => sum+(w.minted||0), 0);
    const pending = state.tasks.filter(t => t.status==='waiting').length;
    tg(msg.chat.id, `📊 *GhostMint Stats*\n\n⬡ Wallets: *${state.wallets.length}*\n⏱ Pending: *${pending}*\n⚡ Minted: *${minted}*\n✅ Success rate: *${total?Math.round(success/total*100):0}%*\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`);
  }));

  bot.onText(/\/canceltask (.+)/, withTelegramUser(async (msg, match, userId) => {
    const id  = parseInt(match[1]);
    const ownedTask = findOwnedTask(DB, userId, id);
    if (!ownedTask) return tg(msg.chat.id, 'Task not found. Use /tasks to see IDs.');
    const idx = DB.tasks.indexOf(ownedTask);
    const name = ownedTask.name;
    DB.tasks.splice(idx, 1); await storage.deleteTask(userId, id);
    const key = taskKey({ userId, id });
    if (taskTimers[key]) { clearTimeout(taskTimers[key]); delete taskTimers[key]; }
    tg(msg.chat.id, `✅ Task *${name}* cancelled.`);
  }));

  bot.onText(/\/removewallet (.+)/, withTelegramUser(async (msg, match, userId) => {
    const label = match[1].trim();
    const ownedWallet = findOwnedWallet(DB, userId, label);
    if (!ownedWallet) return tg(msg.chat.id, `Wallet "${label}" not found.`);
    const idx = DB.wallets.indexOf(ownedWallet);
    const [removed] = DB.wallets.splice(idx, 1); await storage.deleteWallet(userId, removed.label);
    tg(msg.chat.id, `✅ Wallet *${label}* removed.`);
  }));

  bot.onText(/\/mintnow (.+)/, withTelegramUser(async (msg, match, userId) => {
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) return tg(msg.chat.id, 'Usage: /mintnow <label> <contract> [qty] [price] [chain]');
    const [label, contract, qtyStr, priceStr, chain] = parts;
    const wallet = findOwnedWallet(DB, userId, label);
    if (!wallet) return tg(msg.chat.id, `Wallet "${label}" not found. Use /wallets.`);
    const qty=parseInt(qtyStr)||1, price=parseFloat(priceStr)||0, ch=chain||wallet.chain||'ethereum';
    tg(msg.chat.id, `⚡ Minting from *${wallet.label}*...\nContract: \`${contract.slice(0,10)}...\`\nQty: ${qty} | Price: ${price>0?price+' ETH':'Free'}`);
    try {
      const txHash = await executeMint({ wallet, contractAddr:contract, fnName:'mint', qty, priceETH:price, chain:ch });
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
    const txHash = await executeMint({ wallet, contractAddr:task.contract, fnName:task.fn||'mint', qty:task.qty, priceETH:task.price||0, gasGwei:task.gas||null, chain:wallet.chain });
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
