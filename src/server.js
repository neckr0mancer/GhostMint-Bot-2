const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { Buffer }  = require('node:buffer');
const { ethers }  = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const { CHAINS, CONFIG, getSafeConfigSummary } = require('./config');
const { createBotCommandService } = require('./commands/botCommandService');
const { createDatabasePool } = require('./db/pool');
const { createDiscordBot } = require('./discord/discordBot');
const {createDashboardApi}=require('./dashboard/api');
const {createDashboardAuthService}=require('./dashboard/authService');
const {createDashboardSessionRepository}=require('./dashboard/sessionRepository');
const {createDashboardWebSocketHub}=require('./dashboard/webSocketHub');
const { createEtherscanGasService } = require('./gas/etherscanGasService');
const { createReadinessService } = require('./health/readinessService');
const { createIdentityService } = require('./identity/identityService');
const { createPostgresIdentityRepository } = require('./identity/postgresIdentityRepository');
const { findOwnedWallet, stateForUser } = require('./identity/ownership');
const { decodeMintCall, formatMintPreview } = require('./mint/mintCall');
const { createMintExecutionService } = require('./mint/mintExecutionService');
const { createMintService } = require('./mint/mintService');
const { createNotificationService } = require('./notifications/notificationService');
const { createPostgresMintPresetRepository } = require('./mint/postgresMintPresetRepository');
const { createProofResolver, ProofResolutionError } = require('./mint/proofResolver');
const { createSchedulerRepository } = require('./scheduler/schedulerRepository');
const { createSchedulerWorker } = require('./scheduler/schedulerWorker');
const { createSocialAdapters } = require('./social/adapters');
const { createSocialWatchRepository } = require('./social/socialWatchRepository');
const { createSocialWatchService } = require('./social/socialWatchService');
const { createSocialWatchWorker } = require('./social/socialWatchWorker');
const { createSocialUsageService, formatUsageSummary } = require('./social/usageService');
const { createSniperRepository } = require('./sniper/sniperRepository');
const { createSniperService } = require('./sniper/sniperService');
const { createAdminCommandService } = require('./governance/adminCommandService');
const { AuthorizationError, createGovernanceService } = require('./governance/governanceService');
const { createPostgresGovernanceRepository } = require('./governance/postgresGovernanceRepository');
const { createKeyEncryption } = require('./security/keyEncryption');
const { createRedactor } = require('./security/redaction');
const { BotContextError, RateLimitError, commandName, createCommandRateLimiter,
  requireTextConfirmation,verifyTelegramContext } = require('./security/botSecurity');
const { createBotSecurityRepository } = require('./security/botSecurityRepository');
const { createGracefulShutdown } = require('./security/gracefulShutdown');
const { createPostgresStorage } = require('./storage/postgresStorage');
const { createTransactionIntentRepository } = require('./transactions/intentRepository');
const { createTransactionPolicyRepository } = require('./transactions/policyRepository');
const { createProviderService } = require('./transactions/providerService');
const { createTransactionEngine } = require('./transactions/transactionEngine');
const { createTriggerPipeline } = require('./triggers/triggerPipeline');
const { createTargetPolicyRepository } = require('./triggers/targetPolicyRepository');
const { createTargetPolicyService } = require('./triggers/targetPolicyService');
const { createTriggerExecutionService } = require('./triggers/triggerExecutionService');
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
const dashboardAuth=createDashboardAuthService({identity,repository:createDashboardSessionRepository(pool)});
const transactionIntentRepository = createTransactionIntentRepository(pool);
const schedulerRepository = createSchedulerRepository(pool);
const sniperRepository = createSniperRepository(pool);
const socialWatchRepository = createSocialWatchRepository(pool);
const targetPolicyRepository = createTargetPolicyRepository(pool);
const botSecurityRepository = createBotSecurityRepository(pool);
const commandRateLimiter = createCommandRateLimiter();
const dashboardApi=createDashboardApi({auth:dashboardAuth,identityRepository,
  loginRateLimiter:createCommandRateLimiter({limit:5,windowMs:60_000})});
const providerService = createProviderService({
  chains: CHAINS,
  timeoutMs: CONFIG.rpcTimeoutMs,
  retries: CONFIG.rpcRetries,
});
const gasService = createEtherscanGasService({
  apiKey: CONFIG.etherscanApiKey,
  chains: CHAINS,
  timeoutMs: CONFIG.rpcTimeoutMs,
});
const mintPresetRepository = createPostgresMintPresetRepository(pool);
const mintService = createMintService({
  presetRepository: mintPresetRepository,
  proofResolver: createProofResolver(),
  supportedChains: CONFIG.supportedChains,
  providerService,
});
const governanceRepository = createPostgresGovernanceRepository(pool);
const governance = createGovernanceService(governanceRepository);
const adminCommands = createAdminCommandService(governance);
const transactionPolicyRepository = createTransactionPolicyRepository(pool, { governanceRepository });
const socialUsageService = createSocialUsageService({ repository:socialWatchRepository, governance,
  pricing:CONFIG.socialPricing });
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
  CONFIG.discordBotToken,
  CONFIG.socialOfficialApiToken,
  CONFIG.socialManagedServiceToken,
  CONFIG.etherscanApiKey,
  ...Object.values(CONFIG.encryptionKeys),
]);
const log = msg => console.log(`[${new Date().toISOString()}] ${redact(msg)}`);
const safeError = error => redact(error?.reason || error?.message || 'Unknown error');
const dashboardWebSockets=createDashboardWebSocketHub({auth:dashboardAuth,log});
log(`Configuration loaded: ${JSON.stringify(getSafeConfigSummary())}`);
const transactionEngine = createTransactionEngine({
  providerService,
  intentRepository: transactionIntentRepository,
  policyRepository: transactionPolicyRepository,
  decryptPrivateKey: decryptPK,
  notify: event => log(`Transaction ${event.intent.intentId} is ${event.state}`),
});
const mintExecution = createMintExecutionService({ mintService, transactionEngine });
const targetPolicyService = createTargetPolicyService({ repository:targetPolicyRepository,
  governanceRepository, targetExists:async (userId,targetType,targetId) => targetType==='sniper'
    ? DB.snipers.some(item=>item.userId===userId&&item.id===targetId)
    : Boolean(await socialWatchRepository.get(userId,targetId)) });
let triggerExecutionService;

async function prepareTriggeredExecution(event,policy) {
  if(event.triggerSource==='social-triggered') {
    if(!policy.walletLabel||!policy.mintPresetName) throw new ValidationError({field:'targetPolicy',message:'social execution requires walletLabel and mintPresetName'});
    const wallet=findOwnedWallet(DB,event.userId,policy.walletLabel);
    if(!wallet) throw new ValidationError({field:'walletLabel',message:'was not found'});
    const prepared=await mintService.preparePreset(event.userId,policy.mintPresetName,wallet.address);
    if(prepared.preview.contractAddress.toLowerCase()!==event.address.toLowerCase()) throw new ValidationError({field:'mintPresetName',message:'contract does not match the detected social address'});
    return {preview:prepared.preview,executionPayload:{...event,walletLabel:wallet.label,mintPresetName:policy.mintPresetName}};
  }
  return {preview:event.preview,executionPayload:event};
}

async function executeTriggered(event,policy) {
  if(event.triggerSource==='social-triggered') {
    const preparedData=await prepareTriggeredExecution(event,policy);
    const wallet=findOwnedWallet(DB,event.userId,preparedData.executionPayload.walletLabel);
    const prepared=await mintService.preparePreset(event.userId,preparedData.executionPayload.mintPresetName,wallet.address);
    const intent=await mintExecution.executePrepared({userId:event.userId,wallet,prepared,triggerSource:'social',
      idempotencyKey:`social-trigger:${event.userId}:${event.targetId}:${event.id}`});
    return {state:intent.state,intentId:intent.intentId,txHash:intent.txHash};
  }
  const wallet=findOwnedWallet(DB,event.userId,event.walletLabel);
  if(!wallet) throw new ValidationError({field:'walletLabel',message:'was not found'});
  const intent=await transactionEngine.submit({userId:event.userId,wallet,targetId:event.targetId,
    chain:event.chain,triggerSource:'blockchain',to:event.to,data:event.data,valueWei:BigInt(event.valueWei),
    gasPriceWei:event.gasPriceWei?BigInt(event.gasPriceWei):undefined,
    maxFeePerGasWei:event.maxFeePerGasWei?BigInt(event.maxFeePerGasWei):undefined,
    maxPriorityFeePerGasWei:event.maxPriorityFeePerGasWei?BigInt(event.maxPriorityFeePerGasWei):undefined,
    idempotencyKey:`sniper:${event.userId}:${event.targetId}:${event.id}`});
  return {state:intent.state,intentId:intent.intentId,txHash:intent.txHash};
}

triggerExecutionService=createTriggerExecutionService({repository:targetPolicyRepository,
  policyService:targetPolicyService,prepareExecution:prepareTriggeredExecution,execute:executeTriggered,
  notify:(userId,value)=>notifyUser(userId,`Trigger requires confirmation.\n${JSON.stringify(value.preview)}\nRun /confirmtrigger ${value.requestId} CONFIRM within 10 minutes.`)});
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
          event.intent || null, CHAINS[wallet.chain]);
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
  const intent = txHash && typeof txHash === 'object' ? txHash : null;
  const entry = await storage.addActivity({ userId, status, title, walletLabel,
    txHash: intent?.txHash || txHash, explorer: chain?.ex, time: Date.now(),
    actualNetworkCostWei: intent?.actualNetworkCostWei ?? null });
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
  return intent;
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
  beforeExecute:async ({sniper,event,sourceTx,wallet,value,copiedFee}) => {
    const policy=await targetPolicyService.get(sniper.userId,'sniper',sniper.id);
    if(policy.blockchainTrigger==='auto') return true;
    const preview=decodeMintCall({contractAddress:sourceTx.to,calldata:sourceTx.data,valueWei:value});
    const request=await targetPolicyRepository.createRequest({userId:sniper.userId,targetType:'sniper',targetId:sniper.id,
      triggerSource:'blockchain-triggered',sourceEventId:event.txHash,preview,executionPayload:{
        userId:sniper.userId,targetType:'sniper',targetId:sniper.id,triggerSource:'blockchain-triggered',
        address:sourceTx.to,walletLabel:wallet.label,chain:sniper.chain,to:sourceTx.to,data:sourceTx.data,
        valueWei:String(value),gasPriceWei:sourceTx.maxFeePerGas?null:String(copiedFee),
        maxFeePerGasWei:sourceTx.maxFeePerGas?String(copiedFee):null,
        maxPriorityFeePerGasWei:sourceTx.maxFeePerGas?String((sourceTx.maxPriorityFeePerGas||sourceTx.maxFeePerGas)*BigInt(100+sniper.gasBoostPercent)/100n):null,
      },expiresAt:Date.now()+10*60_000});
    await notifyUser(sniper.userId,`Blockchain trigger for *${sniper.label}* requires confirmation. Contract: \`${sourceTx.to}\`.\nRun /confirmtrigger ${request.id} CONFIRM within 10 minutes.`);
    return false;
  },
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
        wallet.label, intent || null, CHAINS[sniper.chain]);
      const policy=await targetPolicyService.get(sniper.userId,'sniper',sniper.id);
      await targetPolicyRepository.addAudit({userId:sniper.userId,targetType:'sniper',targetId:sniper.id,
        triggerSource:'blockchain-triggered',sourceEventId:event.txHash,verificationState:policy.humanVerification,
        dontAskAgain:policy.dontAskAgain,confirmationShown:false,intentId:intent?.intentId,txHash:intent?.txHash,outcome:'confirmed'});
    } else if (state === 'failed') {
      sniper.fails = (sniper.fails || 0) + 1;
      await storage.saveSniper(sniper);
      const policy=await targetPolicyService.get(sniper.userId,'sniper',sniper.id);
      await targetPolicyRepository.addAudit({userId:sniper.userId,targetType:'sniper',targetId:sniper.id,
        triggerSource:'blockchain-triggered',sourceEventId:event.txHash,verificationState:policy.humanVerification,
        dontAskAgain:policy.dontAskAgain,confirmationShown:false,intentId:intent?.intentId,txHash:intent?.txHash,
        outcome:'failed'});
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
        const detected = await sniperService.detect(sniper, { hash:tx.hash, to:tx.to, blockNumber, blockHash:block.hash });
        if (detected) await triggerPipeline.publish({ id:tx.hash,userId:sniper.userId,targetId:sniper.id,
          address:tx.to,triggerSource:'blockchain-triggered',sourceTransactionHash:tx.hash });
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
let discordBot = null;
function tg(chatId, msg) {
  if (bot && chatId) return bot.sendMessage(chatId, String(msg)).catch(e => log('TG: '+safeError(e)));
  return Promise.resolve();
}

const notificationService = createNotificationService({
  identityRepository,
  transports: {
    telegram: (platformUserId, message) => tg(platformUserId, message),
    discord: (platformUserId, message) => discordBot?.sendDirectMessage(platformUserId, message),
  },
  log,
});

async function notifyUser(userId, msg) {
  await notificationService.sendToUser(userId, msg);
}

async function handleTriggerEvent(event) {
  log(`Trigger pipeline received ${event.triggerSource} event ${event.id} for ${event.address}`);
  if (event.triggerSource === 'social-triggered') await triggerExecutionService.handle({ ...event,
    targetType:'social_rule',targetId:event.matchedRuleIds[0] });
}

const triggerPipeline = createTriggerPipeline({ handlers:[handleTriggerEvent], log });

const socialWatchService = createSocialWatchService({
  repository: socialWatchRepository,
  adapters: createSocialAdapters({ officialApi:{ endpoint:CONFIG.socialOfficialApiUrl,
    token:CONFIG.socialOfficialApiToken }, managedService:{ endpoint:CONFIG.socialManagedServiceUrl,
    token:CONFIG.socialManagedServiceToken }, recordUsage:entry => socialWatchRepository.recordUsage(entry) }),
  emitTrigger: event => triggerPipeline.publish(event),
  notifyOwner: notifyUser,
  log,
  pollIntervalMs: CONFIG.socialPollIntervalMs,
});
const socialWatchWorker = createSocialWatchWorker({ service:socialWatchService,
  intervalMs:CONFIG.socialPollIntervalMs, log });

function stateFor(userId) {
  return stateForUser(DB, userId);
}

function withTelegramUser(handler) {
  return async (msg, match) => {
    let context,userId=null;
    const audit=value=>Promise.resolve(botSecurityRepository.record(value)).catch(error=>log(`Security audit write failed: ${safeError(error)}`));
    try {
      context=verifyTelegramContext(msg);
      userId=await identity.resolveOrCreate('telegram',context.platformUserId);
      const command=commandName(msg.text||msg.caption);
      if(['mintnow','mintcall','mintpreset','admin','watch','confirmtrigger','targetpolicy','updatesniper','importwallet'].includes(command)) {
        commandRateLimiter.check('telegram',userId,command);
      }
      await handler(msg, match, userId);
    } catch (error) {
      if (error instanceof ValidationError) {
        tg(msg.chat.id, validationReply(error));
        return;
      }
      if (error instanceof AuthorizationError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'unauthorized',reason:error.message});
        tg(msg.chat.id, '❌ Owner access required.');
        return;
      }
      if(error instanceof RateLimitError){
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'rate_limited',reason:error.message});
        tg(msg.chat.id,`Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`);return;
      }
      if(error instanceof BotContextError){
        await audit({platform:'telegram',platformUserId:msg.from?.id,contextId:msg.chat?.id,
          command:commandName(msg.text||msg.caption),outcome:'invalid_context',reason:error.message});return;
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
    if(msg.text?.startsWith('/')&&!msg.from?.id) log('Telegram command without sender ignored');
  });

  bot.onText(/^\/(?:start|help)(?:@\w+)?$/, withTelegramUser(async msg => {
    tg(msg.chat.id, `*GhostMint Bot*\n\n*Wallet onboarding:*\n/createwallet <label> <chain> — recommended; generates and encrypts a new wallet server-side\n/importwallet <label> <chain> <private-key> — not recommended; the key crosses Telegram message transit and may remain in chat history or notification previews\n/wallets — list wallets\n/removewallet <label> — remove wallet\n\n*Transactions and automation:*\n/mintnow <label> <contract> <qty> <price> <chain>\n/mintcall <JSON>\n/mintpreset save|use|delete <JSON/name>\n/mintpresets\n/tasks\n/canceltask <id>\n/pausetask <id>\n/resumetask <id>\n/retrytask <id>\n/snipers\n/updatesniper <id> <JSON>\n/activity\n/gas\n/stats\n/mode <preset>\n/link\n/admin <action>`);
  }));

  bot.onText(/^\/link(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const link = await identity.createLinkCode(userId);
    tg(msg.chat.id, `🔗 *Account link code:* \`${link.code}\`\n\nExpires in 5 minutes and can be used once.`);
  }));

  bot.onText(/^\/mode(?:@\w+)?\s+(\S+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const selected = await botCommands.selectMode(userId, match[1]);
    tg(msg.chat.id, `✅ Transaction mode set to *${selected.replaceAll('_', ' ')}*.`);
  }));

  bot.onText(/^\/admin(?:@\w+)?\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    tg(msg.chat.id, await botCommands.admin(userId, match[1]));
  }));

  async function runFlexibleMint(msg, userId, payload, manualAuthorization) {
    if(payload.confirmation!=='CONFIRM')throw new ValidationError({field:'confirmation',message:'must exactly equal CONFIRM'});
    delete payload.confirmation;
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
    const intent = await executePreparedMint({ wallet, prepared, chain: payload.chain || wallet.chain,
      onPreview: preview => tg(msg.chat.id, formatMintPreview(preview), {}) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Minted via ${prepared.method.signature}`, wallet.label, intent, CHAINS[payload.chain || wallet.chain]);
    await tg(msg.chat.id, `✅ Mint successful.\n${CHAINS[payload.chain || wallet.chain].ex}${intent.txHash}`, {});
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
    if(payload.confirmation!=='CONFIRM')throw new ValidationError({field:'confirmation',message:'must exactly equal CONFIRM'});
    const wallet = findOwnedWallet(DB, userId, payload.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const prepared = await mintService.preparePreset(userId, payload.name, wallet.address);
    const intent = await executePreparedMint({ wallet, prepared, chain: prepared.chain,
      onPreview: preview => tg(msg.chat.id, formatMintPreview(preview), {}) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Preset mint via ${prepared.method.signature}`, wallet.label, intent, CHAINS[prepared.chain]);
    await tg(msg.chat.id, `✅ Preset mint successful.\n${CHAINS[prepared.chain].ex}${intent.txHash}`, {});
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+delete\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const deleted = await mintService.deletePreset(userId, match[1]);
    await tg(msg.chat.id, deleted ? '✅ Mint preset deleted.' : 'Mint preset not found.');
  }));

  bot.onText(/^\/mintpresets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const presets = await mintService.listPresets(userId);
    await tg(msg.chat.id, presets.length ? presets.map(preset => `• *${preset.name}* — ${preset.methodSignature}`).join('\n') : 'No mint presets saved.');
  }));

  bot.onText(/^\/snipers(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const snipers = botCommands.snipers(userId);
    if (!snipers.length) return tg(msg.chat.id, 'No snipers configured.');
    const list = snipers.map(s =>
      `${s.active?'🟢':'⚪'} *${s.label}*\nTarget: \`${s.targetAddress.slice(0,10)}...\`\nChain: ${CHAINS[s.chain]?.name||s.chain} · Wallet: ${s.walletLabel}\nHits: ${s.hits||0} · Fails: ${s.fails||0}`
    ).join('\n\n');
    tg(msg.chat.id, `🎯 *Post-confirmation copy snipers (${snipers.length})*\n_Not mempool front-running: copying begins only after the source transaction confirms._\n\n${list}`);
  }));

  bot.onText(/^\/updatesniper(?:@\w+)?\s+([0-9a-f-]+)\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[3]);
    const updated = await botCommands.updateSniper(userId, match[1], commandJson(match[2]));
    const sniper = botCommands.snipers(userId).find(item => item.id === updated.id);
    tg(msg.chat.id, `✅ Post-confirmation copy sniper *${sniper.label}* updated. This is not mempool front-running.`);
  }));

  bot.onText(/^\/wallets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return tg(msg.chat.id, 'No wallets yet.');
    const list = wallets.map((w,i) =>
      `${i+1}. *${w.label}*\n   \`${w.address.slice(0,6)}...${w.address.slice(-4)}\` · ${CHAINS[w.chain]?.name||w.chain} · minted: ${w.minted||0}`
    ).join('\n\n');
    tg(msg.chat.id, `⬡ *Wallets (${wallets.length})*\n\n${list}`);
  }));

  bot.onText(/^\/createwallet(?:@\w+)?\s+(\S+)\s+(\S+)$/i, withTelegramUser(async (msg, match, userId) => {
    const wallet = await botCommands.createWallet(userId, { label: match[1], chain: match[2] });
    tg(msg.chat.id, `✅ Wallet *${wallet.label}* generated securely.\nPublic address: \`${wallet.address}\`\nChain: ${wallet.chain}\n\nFund this public address to use it. The private key was encrypted at creation and is never returned through Telegram.`);
  }));

  bot.onText(/^\/importwallet(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)$/i, withTelegramUser(async (msg, match, userId) => {
    const wallet = await botCommands.importWallet(userId, { label: match[1], chain: match[2], privateKey: match[3] });
    tg(msg.chat.id, `✅ Wallet *${wallet.label}* imported at \`${wallet.address}\`.\n\n⚠️ *Not recommended:* the private key passed through Telegram's message transit and may remain in client history or notification previews. Prefer /createwallet; a future HTTPS dashboard will provide a safer import path.`);
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+add\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.createWatchRule(userId, commandJson(match[1]));
    tg(msg.chat.id, `✅ Social watch rule *${rule.name}* created using ${rule.method}.`);
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+edit\s+([0-9a-f-]+)\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.updateWatchRule(userId, match[1], commandJson(match[2]));
    tg(msg.chat.id, `✅ Social watch rule *${rule.name}* updated; ${rule.method} adapter selected.`);
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+disable\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.disableWatchRule(userId, match[1]);
    tg(msg.chat.id, `⏸ Social watch rule *${rule.name}* disabled.`);
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+remove\s+([0-9a-f-]+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    await botCommands.removeWatchRule(userId, match[1]);
    tg(msg.chat.id, '✅ Social watch rule removed.');
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+list$/i, withTelegramUser(async (msg, match, userId) => {
    const rules = await botCommands.watchRules(userId);
    tg(msg.chat.id, rules.length ? rules.map(rule => `${rule.enabled?'🟢':'⚪'} *${rule.name}* — ${rule.type} via ${rule.method}\nID: \`${rule.id}\``).join('\n\n') : 'No social watch rules.');
  }));

  bot.onText(/^\/socialusage(?:@\w+)?(?:\s+(today|month))?$/i, withTelegramUser(async (msg, match, userId) => {
    tg(msg.chat.id, formatUsageSummary(await botCommands.socialUsage(userId, match[1] || 'month')));
  }));

  bot.onText(/^\/targetpolicy(?:@\w+)?\s+set\s+(.+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[2]);
    const policy=await botCommands.updateTargetPolicy(userId,commandJson(match[1]));
    tg(msg.chat.id,`✅ Target policy saved: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}.`);
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+show\s+(sniper|social_rule)\s+([0-9a-f-]+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const policy=await botCommands.targetPolicy(userId,match[1],match[2]);
    tg(msg.chat.id,`Target policy: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}, acknowledged ${policy.dontAskAgain?'yes':'no'}.`);
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+reset\s+(sniper|social_rule)\s+([0-9a-f-]+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[3]);
    const policy=await botCommands.resetTargetPolicy(userId,match[1],match[2]);
    tg(msg.chat.id,`✅ Target policy reset: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}.`);
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+bypass\s+(.+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const result=await botCommands.requestTargetBypass(userId,commandJson(match[1]));
    tg(msg.chat.id,result.requiresConfirmation?`${result.warning}\nChallenge: \`${result.challengeId}\`\nUse /confirmbypass ${result.challengeId} CONFIRM`:'✅ Verification bypass enabled for this previously acknowledged target.');
  }));
  bot.onText(/^\/confirmbypass(?:@\w+)?\s+([0-9a-f-]+)\s+(\S+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const policy=await botCommands.confirmTargetBypass(userId,{challengeId:match[1],confirmation:match[2]});
    tg(msg.chat.id,`✅ Verification is now ${policy.humanVerification} for this target.`);
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+preset\s+(.+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[2]);
    const result=await botCommands.applyTargetPreset(userId,commandJson(match[1]));
    tg(msg.chat.id,result.requiresConfirmation?`${result.warning}\nChallenge: \`${result.challengeId}\`\nUse /confirmbypass ${result.challengeId} CONFIRM`:`✅ Target preset applied; verification ${result.humanVerification}.`);
  }));
  bot.onText(/^\/confirmtrigger(?:@\w+)?\s+([0-9a-f-]+)\s+(\S+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const result=await botCommands.confirmTrigger(userId,match[1],match[2]);tg(msg.chat.id,`✅ Triggered mint ${result.result.state}.`);
  }));
  bot.onText(/^\/triggeraudit(?:@\w+)?$/i,withTelegramUser(async(msg,match,userId)=>{
    const rows=await botCommands.triggerAudit(userId);tg(msg.chat.id,rows.length?rows.map(row=>`${row.trigger_source} | ${row.target_type}:${row.target_id} | verification ${row.verification_state} | ${row.outcome}`).join('\n'):'No trigger executions audited.');
  }));
  bot.onText(/^\/pending(?:@\w+)?$/i,withTelegramUser(async(msg,match,userId)=>{
    const [transactions,confirmations]=await Promise.all([botCommands.pendingTransactions(userId),botCommands.pendingConfirmations(userId)]);
    tg(msg.chat.id,`Pending transactions: ${transactions.length}\n${transactions.map(row=>`${row.intentId} | ${row.state} | ${row.chain}`).join('\n')||'None'}\n\nPending confirmations: ${confirmations.length}\n${confirmations.map(row=>`${row.id} | ${row.triggerSource} | expires ${new Date(row.expiresAt).toISOString()}`).join('\n')||'None'}`);
  }));
  bot.onText(/^\/transactions(?:@\w+)?(?:\s+(\d+))?$/i,withTelegramUser(async(msg,match,userId)=>{
    const page=await botCommands.transactionsPage(userId,{page:match[1]||1});
    const rows=page.items.map(row=>`${row.intentId} | ${row.state} | ${row.chain}`).join('\n')||'No transactions.';
    tg(msg.chat.id,`Transactions (page ${page.page}/${page.totalPages}, ${page.total} total)\n${rows}`);
  }));

  bot.onText(/^\/tasks(?:@\w+)?(?:\s+(\d+))?$/, withTelegramUser(async (msg, match, userId) => {
    const page = await botCommands.tasksPage(userId, { page: match[1] || 1 });
    const pending = page.items;
    if (!pending.length) return tg(msg.chat.id, 'No scheduled tasks.');
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ *${t.name}* [${t.status}]\nWallet: ${t.walletLabel}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nDue (UTC): *${new Date(t.mintTime).toISOString()}*${ms>0?`\nFires in: *${fmtCD(ms)}*`:''}\nID: \`${t.id}\``;
    }).join('\n\n');
    tg(msg.chat.id, `⏱ *Tasks (page ${page.page}/${page.totalPages}, ${page.total} total)*\n\n${list}`);
  }));

  bot.onText(/^\/activity(?:@\w+)?(?:\s+(\d+))?$/, withTelegramUser(async (msg, match, userId) => {
    const page = await botCommands.activityPage(userId, { page: match[1] || 1 });
    const recent = page.items;
    if (!recent.length) return tg(msg.chat.id, 'No activity yet.');
    const list = recent.map(a => {
      const ico = a.status==='success'?'✅':'❌';
      const tx  = a.txHash?`\n   [View tx](${a.explorer}${a.txHash})`:'';
      return `${ico} ${a.title} · *${a.walletLabel}*\n   ${new Date(a.time).toLocaleString()}${tx}`;
    }).join('\n\n');
    tg(msg.chat.id, `📋 *Activity (page ${page.page}/${page.totalPages}, ${page.total} total)*\n\n${list}`);
  }));

  bot.onText(/^\/gas(?:@\w+)?$/, withTelegramUser(async msg => {
    try {
      const fees = await botCommands.gas('ethereum');
      tg(msg.chat.id, `⛽ *Live Gas (Ethereum)*\nGas price: *${fees.gasPriceGwei ?? 'unavailable'}* Gwei\nMax fee: *${fees.maxFeePerGasGwei ?? 'unavailable'}* Gwei`);
    } catch { tg(msg.chat.id, 'Could not fetch gas prices.'); }
  }));

  bot.onText(/^\/stats(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const state = stateFor(userId);
    const stats = await botCommands.stats(userId);
    const minted = state.wallets.reduce((sum,w) => sum+(w.minted||0), 0);
    const pending = (await schedulerRepository.listForUser(userId)).filter(t => ['scheduled','retry','claimed','paused'].includes(t.status)).length;
    tg(msg.chat.id, `📊 *GhostMint Stats*\n\n⬡ Wallets: *${state.wallets.length}*\n⏱ Pending: *${pending}*\n⚡ Minted: *${minted}*\n⏭ Skipped: *${stats.skipped}*\n✅ Success rate: *${stats.successRate}%*\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`);
  }));

  bot.onText(/^\/canceltask(?:@\w+)?\s+([0-9a-f-]+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const task = await botCommands.controlTask(userId, 'cancel', match[1]);
    tg(msg.chat.id, `✅ Task *${task.name}* cancelled.`);
  }));

  bot.onText(/^\/pausetask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const task = await botCommands.controlTask(userId, 'pause', match[1]);
    tg(msg.chat.id, `⏸ Task *${task.name}* paused.`);
  }));

  bot.onText(/^\/resumetask(?:@\w+)?\s+([0-9a-f-]+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const task = await botCommands.controlTask(userId, 'resume', match[1]);
    tg(msg.chat.id, `▶ Task *${task.name}* resumed.`);
  }));

  bot.onText(/^\/retrytask(?:@\w+)?\s+([0-9a-f-]+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const task = await botCommands.controlTask(userId, 'retry', match[1]);
    tg(msg.chat.id, `↻ Task *${task.name}* queued for retry.`);
  }));

  bot.onText(/^\/removewallet(?:@\w+)?\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const label = await botCommands.removeWallet(userId, match[1]);
    tg(msg.chat.id, `✅ Wallet *${label}* removed.`);
  }));

  bot.onText(/^\/mintnow(?:@\w+)?\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
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
      const result = await botCommands.mint(userId, request);
      tg(msg.chat.id, `✅ *Mint successful!*\nWallet: *${wallet.label}*\nQty: ${qty}\n[View tx](${CHAINS[ch].ex}${result.txHash})`);
    } catch(e) {
      await logActivity(userId, 'fail','Mint failed',wallet.label,null,CHAINS[ch]);
      tg(msg.chat.id, `❌ *Mint failed*\n${safeError(e).slice(0,120)}`);
    }
  }));
} else {
  log('⚠️  No TELEGRAM_BOT_TOKEN — Telegram disabled.');
}

const botCommands = createBotCommandService({
  storage,
  schedulerRepository,
  providerService,
  governance,
  adminCommands,
  sniperService,
  socialWatchService,
  socialUsageService,
  targetPolicyService,
  triggerExecutionService,
  triggerAuditRepository:targetPolicyRepository,
  transactionIntentRepository,
  gasService,
  sniperRepository,
  governanceRepository,
  supportedChains: CONFIG.supportedChains,
  chains: CHAINS,
  encryptPrivateKey: encryptPK,
  getState: () => DB,
  ensureChainWatcher,
  executeMint: async ({ userId, wallet, request }) => {
    const intent = await executeMint({ wallet, contractAddr: request.contractAddress,
      qty: request.quantity, priceETH: request.priceETH, gasGwei: request.gasGwei,
      chain: request.chain, triggerSource: 'manual' });
    wallet.minted = (wallet.minted || 0) + request.quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Minted ${request.quantity} NFT${request.quantity > 1 ? 's' : ''}`,
      wallet.label, intent, CHAINS[request.chain]);
    return intent;
  },
});

if (CONFIG.discordBotToken) {
  discordBot = createDiscordBot({ token: CONFIG.discordBotToken,
    applicationId: CONFIG.discordApplicationId, devGuildId: CONFIG.discordDevGuildId,
    identity, commands: botCommands, securityAudit:botSecurityRepository,rateLimiter:commandRateLimiter,log });
} else {
  log('Discord disabled because credentials are not configured.');
}

// ── Task Scheduler ────────────────────────────────────────
// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(dashboardApi.securityHeaders);
app.post('/api/auth/login',dashboardApi.login);
app.post('/api/auth/logout',dashboardApi.requireSession,dashboardApi.requireCsrf,dashboardApi.logout);
app.post('/api/auth/logout-all',dashboardApi.requireSession,dashboardApi.requireCsrf,dashboardApi.logoutAll);
app.get('/api/profile',dashboardApi.requireSession,dashboardApi.profile);
app.use('/api',(req,res)=>res.status(404).json({error:'API route not found'}));
app.use('/dashboard/assets',express.static(path.join(PROJECT_ROOT,'public','dashboard','assets'),{immutable:true,maxAge:'1y'}));
app.get(['/dashboard','/dashboard/*'],(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(PROJECT_ROOT,'public','dashboard','index.html'));});
app.use(express.static(path.join(PROJECT_ROOT,'public'),{setHeaders:(res,file)=>res.set('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=3600')}));

// ── API ───────────────────────────────────────────────────
const readinessService=createReadinessService({database:storage,providerService,
  chains:CONFIG.supportedChains,schedulerWorker,socialWatchWorker,
  sniperHealth:()=>({status:'up',activeChains:Object.keys(sniperProviders).length})});
app.get('/health', async (req,res) => {
  const health=await readinessService.inspect();
  res.status(health.status==='ok'?200:503).json({...health,uptime:Math.floor(process.uptime())});
});
app.get('*', (req,res) => res.sendFile(path.join(PROJECT_ROOT,'public','index.html')));

// ── Start ─────────────────────────────────────────────────
let httpServer=null;
async function start() {
  DB = await storage.loadSystemState();
  const reconciled = await transactionEngine.reconcileNonFinal();
  log(`Reconciled ${reconciled.length} non-final transaction intents`);
  const recovered = await schedulerWorker.recoverStaleClaims();
  log(`Recovered ${recovered} expired scheduler claims`);
  if (discordBot) {
    const discordUser = await discordBot.start();
    log(`Discord bot started as ${discordUser?.tag || discordUser?.id || 'configured application'}`);
  }
  schedulerWorker.start();
  socialWatchWorker.start();
  log('Started social watch-rule worker');
  log(`Started durable scheduler with ${await schedulerRepository.countActive()} active tasks`);
  DB.snipers.filter(s => s.active).forEach(s => ensureChainWatcher(s.chain));
  log(`Restored ${DB.snipers.filter(s=>s.active).length} active snipers`);
  httpServer=app.listen(PORT, () => {
    log(`GhostMint running on port ${PORT}`);
    log(`Wallets: ${DB.wallets.length} | Tasks: ${DB.tasks.length}`);
  });
  dashboardWebSockets.attach(httpServer);
}

const gracefulShutdown=createGracefulShutdown({getHttpServer:()=>httpServer,telegramBot:bot,discordBot,
  schedulerWorker,socialWatchWorker,webSocketHub:dashboardWebSockets,stopWatchers:()=>Object.keys(sniperProviders).forEach(chain=>{
    sniperProviders[chain].removeAllListeners();sniperProviders[chain].destroy?.();delete sniperProviders[chain];
  }),pool,log});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>gracefulShutdown(signal)
  .then(()=>{process.exitCode=0;}).catch(error=>{log(`Shutdown failed: ${safeError(error)}`);process.exitCode=1;}));

start().catch(error => {
  log(`Startup failed: ${safeError(error)}`);
  process.exitCode = 1;
});

process.on('unhandledRejection', e => log('Rejection: '+safeError(e)));
process.on('uncaughtException',  e => log('Exception: '+safeError(e)));
