const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { Buffer }  = require('node:buffer');
const { ethers }  = require('ethers');
const WebSocket   = require('ws');
const { TelegramBot } = require('node-telegram-bot-api');
const axios       = require('axios');
const { CHAINS, CONFIG, getSafeConfigSummary } = require('./config');
const { createBotCommandService } = require('./commands/botCommandService');
const { createDatabasePool } = require('./db/pool');
const { createDiscordBot } = require('./discord/discordBot');
const {createDashboardApi,mountDashboardRoutes}=require('./dashboard/api');
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
const { createContractValueRepository } = require('./mint/contractValueRepository');
const { createContractValueResolver } = require('./mint/contractValueResolver');
const { createSeaDropDiscoveryService } = require('./mint/seaDropDiscoveryService');
const { createSeaDropPublicDropResolver } = require('./mint/seaDropPublicDropResolver');
const { computeSeaDropValueWei } = require('./mint/seaDropCall');
const { SEADROP_MINT_SIGNATURE } = require('./mint/seaDropRegistry');
const { detectContractChain } = require('./mint/chainDetector');
const { createSchedulerRepository } = require('./scheduler/schedulerRepository');
const { createSchedulerWorker } = require('./scheduler/schedulerWorker');
const { createSocialAdapters } = require('./social/adapters');
const { createSocialWatchRepository } = require('./social/socialWatchRepository');
const { createSocialWatchService } = require('./social/socialWatchService');
const { createSocialWatchWorker } = require('./social/socialWatchWorker');
const { createRetentionWorker } = require('./governance/retentionWorker');
const { createSocialUsageService, formatUsageSummary } = require('./social/usageService');
const { createFlowStateStore } = require('./telegram/flowState');
const telegramMenus = require('./telegram/menus');
const { createChainWatcher } = require('./sniper/chainWatcher');
const { createSniperRepository } = require('./sniper/sniperRepository');
const { createSniperService } = require('./sniper/sniperService');
const { createAdminCommandService } = require('./governance/adminCommandService');
const { AccountBlockedError, AuthorizationError, createGovernanceService } = require('./governance/governanceService');
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
const { createTransactionEngine, TransactionSafetyError } = require('./transactions/transactionEngine');
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
// dashboardWebSockets is created further below; referencing it inside this closure is safe since
// the closure only runs later, once a link code is actually consumed (well after the hub exists).
const identity = createIdentityService(identityRepository, {
  broadcast: (userId, message) => dashboardWebSockets.broadcastToUser(userId, message),
});
const dashboardAuth=createDashboardAuthService({identity,repository:createDashboardSessionRepository(pool)});
const transactionIntentRepository = createTransactionIntentRepository(pool);
const schedulerRepository = createSchedulerRepository(pool);
const sniperRepository = createSniperRepository(pool);
const socialWatchRepository = createSocialWatchRepository(pool);
const targetPolicyRepository = createTargetPolicyRepository(pool);
const botSecurityRepository = createBotSecurityRepository(pool);
const commandRateLimiter = createCommandRateLimiter();
// Key export gets its own, much stricter bucket than every other sensitive command -- shared
// across Telegram and the dashboard (this one instance is passed into createDashboardApi below) so
// a user can't just switch platforms to double their effective rate. Two per hour is generous for
// "I need to back this up occasionally" and tight for anything automated.
const exportKeyRateLimiter = createCommandRateLimiter({ limit: 2, windowMs: 60 * 60 * 1000 });
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
const contractValueRepository = createContractValueRepository(pool);
const contractValueResolver = createContractValueResolver({
  providerService,
  repository: contractValueRepository,
});
const seaDropPublicDropResolver = createSeaDropPublicDropResolver({ providerService });
const seaDropDiscoveryService = createSeaDropDiscoveryService({
  providerService,
  publicDropResolver: seaDropPublicDropResolver,
  chains: CHAINS,
  apiKey: CONFIG.etherscanApiKey,
  repository: contractValueRepository,
});
const governanceRepository = createPostgresGovernanceRepository(pool);
const governance = createGovernanceService(governanceRepository);
const adminCommands = createAdminCommandService(governance, identity);
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
  // Covers both branches below: the manual-confirm path (/confirmtrigger) already passes through the
  // per-command account-status choke point, so this is a harmless redundant re-check there, but the
  // fully-automatic social-auto-with-bypass path (triggerExecutionService.handle -> here, with no
  // human command in between) has no other gate at all -- same reasoning as the scheduler and sniper
  // fixes above.
  await governance.checkAccountStatus(event.userId);
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
  notify:(userId,value)=>notifyUser(userId,`Trigger requires confirmation.\n${JSON.stringify(value.preview)}\nRun /confirmtrigger ${value.requestId} CONFIRM to approve or REJECT to reject within 10 minutes.`),
  onPending:(userId,request)=>dashboardWebSockets.broadcastToUser(userId,{type:'confirmation.pending',request}),
  onResolved:(userId,value)=>dashboardWebSockets.broadcastToUser(userId,{type:'confirmation.resolved',...value})});
const schedulerWorker = createSchedulerWorker({
  repository: schedulerRepository,
  intentRepository: transactionIntentRepository,
  transactionEngine,
  executeTask: async (task, hooks) => {
    // Scheduled tasks are created while the owning account is in good standing, but the account can
    // be banned/suspended/deactivated afterward -- account-status enforcement otherwise only runs at
    // the per-command choke point (identity.resolveOrCreate), which this background worker loop never
    // passes through. AccountBlockedError isn't in schedulerWorker's TRANSIENT_CODES, so this is
    // correctly classified as a permanent (non-retried) failure rather than retried indefinitely.
    await governance.checkAccountStatus(task.userId);
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
          event.intent || null, CHAINS[wallet.chain],{triggerSource:'scheduled'});
      }
      await notifyUser(event.task.userId, `✅ Scheduled mint *${event.task.name}* confirmed.`);
    }
    if (['failure','failed'].includes(event.outcome)) {
      if (wallet) await logActivity(event.task.userId, 'fail', `Scheduled mint failed: ${event.task.name}`,
        wallet.label, event.intent?.txHash || null, CHAINS[wallet.chain],{triggerSource:'scheduled'});
      await notifyUser(event.task.userId, `❌ Scheduled mint *${event.task.name}* failed.`);
    }
  },
  log,
  sanitizeError:safeError,
});

// ── Activity ──────────────────────────────────────────────
async function logActivity(userId, status, title, walletLabel, txHash, chain,context={}) {
  const intent = txHash && typeof txHash === 'object' ? txHash : null;
  const entry = await storage.addActivity({ userId, status, title, walletLabel,
    txHash: intent?.txHash || txHash, explorer: chain?.ex, time: Date.now(),
    actualNetworkCostWei: intent?.actualNetworkCostWei ?? null,
    triggerSource:context.triggerSource??null,verificationState:context.verificationState??null });
  DB.activity.unshift(entry);
  if (DB.activity.length > 200) DB.activity.pop();
  // logActivity is the sole writer of activity entries (mint, scheduled mint, sniper copy-mint,
  // mintcall/mintpreset all funnel through here), so it's the one place that needs to know a
  // transaction happened in order to push both a live activity-feed update and a live balance
  // refresh -- a 'fail' entry moved no funds, so only 'success' also triggers wallets.changed and
  // drops the cached balance for that wallet (botCommands is created further below; referencing it
  // here is safe since logActivity only runs later, once a transaction actually completes).
  dashboardWebSockets.broadcastToUser(userId, {type:'activity.changed'});
  if (status === 'success') {
    dashboardWebSockets.broadcastToUser(userId, {type:'wallets.changed'});
    botCommands.invalidateBalance(userId, walletLabel);
  }
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

// Shared by both botCommands.executeMint (Discord's /mint and Telegram's guided flow, via the local
// executeMint()) and botCommands.executePreparedMint (the dashboard's preview/confirm flow) so every
// successful mint is logged to Activity the same way regardless of which platform triggered it --
// previously these were two independently-written copies whose message text and increment logic
// could silently drift apart.
async function recordMintActivity({ userId, wallet, quantity, intent, chain }) {
  wallet.minted = (wallet.minted || 0) + quantity;
  await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
  await logActivity(userId, 'success', `Minted ${quantity} NFT${quantity === 1 ? '' : 's'}`,
    wallet.label, intent, CHAINS[chain], { triggerSource: 'manual' });
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

// Shared quick-mint landing point for every platform: Discord's /mint calls straight into this via
// botCommands.mint(), and Telegram's guided flow's final step (finishMintExecution) does the same.
// SeaDrop tokens don't implement any whitelisted mint(...) signature (see seaDropCall.js) --
// checking here, once, is what gives SeaDrop support to both platforms without either needing its
// own SeaDrop-aware flow.
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
  const seaDrop = await seaDropDiscoveryService.resolve(request.chain, request.contractAddress);
  const prepared = seaDrop.address
    ? await mintService.prepare({
      contractAddress: request.contractAddress,
      methodSignature: SEADROP_MINT_SIGNATURE,
      seaDropAddress: seaDrop.address,
      arguments: [seaDrop.feeRecipient, '$wallet', request.quantity],
      walletAddress: wallet.address,
      valueWei: seaDrop.publicDrop
        ? computeSeaDropValueWei({ mintPriceWei: seaDrop.publicDrop.mintPriceWei, quantity: request.quantity })
        : ethers.parseEther(String(request.priceETH)) * BigInt(request.quantity),
      chain: request.chain,
    })
    : await mintService.prepare({
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
const chainWatchers = {};
const sniperService = createSniperService({
  repository:sniperRepository,
  intentRepository:transactionIntentRepository,
  transactionEngine,
  supportedChains:CONFIG.supportedChains,
  beforeExecute:async ({sniper,event,sourceTx,wallet,value,copiedFee}) => {
    // Same reasoning as the scheduler's executeTask above: a sniper can be created while its owner is
    // in good standing and later that account gets banned/suspended/deactivated, but the chain
    // watcher's block loop never passes through the per-command account-status choke point. Returning
    // false (rather than throwing) matches beforeExecute's existing boolean contract -- sniperService
    // routes it through the same skip() path already used for pending manual confirmation, landing the
    // event in a definitive terminal 'skipped' state rather than retrying it on the next block.
    try { await governance.checkAccountStatus(sniper.userId); }
    catch (error) {
      if (error instanceof AccountBlockedError) {
        log(`Sniper ${sniper.id} skipped: owner account is ${error.status}`);
        return false;
      }
      throw error;
    }
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
    dashboardWebSockets.broadcastToUser(sniper.userId,{type:'confirmation.pending',request});
    await notifyUser(sniper.userId,`Blockchain trigger for *${sniper.label}* requires confirmation. Contract: \`${sourceTx.to}\`.\nRun /confirmtrigger ${request.id} CONFIRM to approve or REJECT to reject within 10 minutes.`);
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
        wallet.label, intent || null, CHAINS[sniper.chain],{triggerSource:'blockchain-triggered',
          verificationState:(await targetPolicyService.get(sniper.userId,'sniper',sniper.id)).humanVerification});
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
    dashboardWebSockets.broadcastToUser(sniper.userId,{type:'snipers.changed'});
    await notifyUser(sniper.userId, state === 'confirmed'
      ? `✅ Post-confirmation copy *${sniper.label}* confirmed.`
      : `🎯 Post-confirmation copy *${sniper.label}*: ${state}${reason ? ` — ${reason}` : ''}${error ? ` — ${safeError(error).slice(0,120)}` : ''}`);
  },
});

const activeSnipersForChain = chain => DB.snipers.filter(s => s.active && s.chain === chain);

function ensureChainWatcher(chain) {
  if (chainWatchers[chain] || !CHAINS[chain]) return;
  const watcher = createChainWatcher({
    chain, rpcUrls: CHAINS[chain].rpcUrls, wsUrl: CHAINS[chain].rpcWsUrl,
    providerFactory: url => new ethers.JsonRpcProvider(url),
    wsProviderFactory: url => {
      const socket = new WebSocket(url);
      const provider = new ethers.WebSocketProvider(socket, CHAINS[chain].chainId);
      socket.on('close', () => provider.emit('error', new Error('WebSocket closed')));
      socket.on('error', error => provider.emit('error', error));
      return provider;
    },
    onBlock: (bn, provider) => onBlock(chain, bn, provider).catch(e => log(`Sniper block err (${chain}): ${safeError(e)}`)),
    log,
  });
  chainWatchers[chain] = watcher;
  watcher.start();
  log(`🎯 Sniper watcher started on ${CHAINS[chain].name} (${watcher.mode() === 'ws' ? 'WebSocket live push' : 'HTTP polling'})`);
}

function teardownChainWatcherIfIdle(chain) {
  if (activeSnipersForChain(chain).length) return;
  const watcher = chainWatchers[chain];
  if (!watcher) return;
  watcher.stop();
  delete chainWatchers[chain];
  log(`🎯 Sniper watcher stopped on ${chain} (no active targets)`);
}

async function onBlock(chain, blockNumber, provider) {
  const snipers = activeSnipersForChain(chain);
  if (!snipers.length) return;
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
function tg(chatId, msg, options = {}) {
  if (bot && chatId) return bot.sendMessage(chatId, String(msg), options).catch(e => log('TG: '+safeError(e)));
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
  dashboardWebSockets.broadcastToUser(event.userId,
    {type: event.triggerSource === 'social-triggered' ? 'watchrules.changed' : 'snipers.changed'});
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
// Hourly is intentionally coarse: a scheduled group removal is measured in days/weeks, not minutes,
// so there is no need for a dedicated CONFIG knob the way the sub-minute social/scheduler polls have.
const retentionWorker = createRetentionWorker({ repository: governanceRepository, intervalMs: 60 * 60 * 1000, log });

function stateFor(userId) {
  return stateForUser(DB, userId);
}

// ── Telegram guided-menu UX (Milestone 15a/15b) ──────────────
// A persistent inline-keyboard menu plus a small per-chat flow-state tracker for multi-step
// actions (wallet create/import today; the same pattern extends to mint/task/sniper flows in a
// follow-up pass). None of this bypasses botCommands/validation/the transaction engine — every
// guided step ends by calling the exact same service function the equivalent slash command uses.
const telegramFlowState = createFlowStateStore();
const FLOW_LABELS = { wallet_create: 'creating a wallet', wallet_import: 'importing a wallet', mint_guided: 'minting', send_guided: 'sending funds', export_guided: 'exporting a private key' };
const FLOW_CONTINUATION_PREFIXES = { wallet_create: ['flow:chain:'], wallet_import: ['flow:chain:'],
  mint_guided: ['flow:wallettoggle:', 'flow:walletpick:', 'flow:walletcontinue', 'flow:mintconfirm'],
  send_guided: ['flow:sendwalletpick:', 'flow:sendconfirm'],
  export_guided: ['flow:exportwalletpick:', 'flow:exportconfirm'] };

// Generic one-shot confirmation gate for simple "<command> <id> CONFIRM"-shaped destructive actions
// (remove wallet, cancel/resume/retry task, remove watch rule) -- replaces typing the literal word
// CONFIRM with a single inline tap. Only one pending confirmation exists per chat at a time, the
// same "one thing in flight" rule telegramFlowState already applies to guided flows; issuing a
// second confirmable command simply replaces whatever was pending before it.
const pendingConfirmations = new Map();
const PENDING_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

function setPendingConfirmation(chatId, run) {
  pendingConfirmations.set(chatId, { run, expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS });
}

function takePendingConfirmation(chatId) {
  const pending = pendingConfirmations.get(chatId);
  pendingConfirmations.delete(chatId);
  return pending && pending.expiresAt >= Date.now() ? pending : null;
}

function confirmationKeyboard() {
  return telegramMenus.keyboard([[telegramMenus.button('✅ Confirm', 'confirm:pending'), telegramMenus.button('❌ Cancel', 'cancel:pending')]]);
}

function cancelOnlyKeyboard() {
  return telegramMenus.keyboard([[telegramMenus.button('❌ Cancel', 'flow:cancel:ask')]]);
}

// userId/data are only needed by the mint_guided steps below (to list the user's wallets and to
// render an accumulated summary); wallet_create/wallet_import ignore them, so every existing call
// site that only passes (flow, step) keeps working unchanged.
function renderFlowStep(flow, step, { userId, data = {} } = {}) {
  if (flow === 'wallet_create') {
    if (step === 'awaiting_label') return { text: 'Send the label for your new wallet (letters, numbers, spaces, `.`, `_`, `-`).', replyMarkup: cancelOnlyKeyboard() };
    if (step === 'awaiting_chain') return telegramMenus.chainPicker(CONFIG.supportedChains, CHAINS);
  }
  if (flow === 'wallet_import') {
    if (step === 'awaiting_label') return { text: 'Send the label for the wallet you are importing.', replyMarkup: cancelOnlyKeyboard() };
    if (step === 'awaiting_chain') return telegramMenus.chainPicker(CONFIG.supportedChains, CHAINS);
    if (step === 'awaiting_key') return { text: '⚠️ *Not recommended:* send the private key now. It passes through Telegram message transit and may remain in chat history or notification previews. Delete your message afterward if you can.', replyMarkup: cancelOnlyKeyboard() };
  }
  if (flow === 'mint_guided') {
    if (step === 'awaiting_contract') return { text: 'Send the contract address to mint from.', replyMarkup: cancelOnlyKeyboard() };
    if (step === 'awaiting_wallet') {
      const wallets = botCommands.wallets(userId);
      return data.multi
        ? telegramMenus.walletMultiPicker(wallets, data.selectedWallets || [], { emptyHint: 'No wallets yet. Create one first from the Wallets menu.' })
        : telegramMenus.walletPicker(wallets, { prefix: 'flow:walletpick', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' });
    }
    if (step === 'awaiting_price') {
      return { text: `This contract does not expose a recognized price function. Send the price per item in ${CHAINS[data.chain]?.sym || 'native currency'} (send 0 if it is free).`, replyMarkup: cancelOnlyKeyboard() };
    }
    if (step === 'awaiting_confirm') {
      return telegramMenus.mintConfirmation({
        contractAddress: data.contractAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        walletLabels: data.selectedWallets,
        priceETH: data.priceETH,
        priceUnknown: data.priceUnknown,
      });
    }
  }
  if (flow === 'send_guided') {
    if (step === 'awaiting_wallet') {
      return telegramMenus.walletPicker(botCommands.wallets(userId), { prefix: 'flow:sendwalletpick', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' });
    }
    if (step === 'awaiting_amount') {
      return { text: `How much ${CHAINS[data.chain]?.sym || 'native currency'} do you want to send from *${data.walletLabel}*?`, replyMarkup: cancelOnlyKeyboard() };
    }
    if (step === 'awaiting_destination') {
      return { text: 'Send the destination address.', replyMarkup: cancelOnlyKeyboard() };
    }
    if (step === 'awaiting_confirm') {
      const totalWei = BigInt(data.estimatedCostWei);
      const amountWei = ethers.parseEther(String(data.amountETH));
      return telegramMenus.sendConfirmation({
        walletLabel: data.walletLabel,
        toAddress: data.toAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        amountETH: data.amountETH,
        sym: CHAINS[data.chain]?.sym || '',
        estimatedGasETH: ethers.formatEther(totalWei - amountWei),
        totalETH: ethers.formatEther(totalWei),
      });
    }
  }
  if (flow === 'export_guided') {
    if (step === 'awaiting_wallet') {
      return telegramMenus.walletPicker(botCommands.wallets(userId), { prefix: 'flow:exportwalletpick', emptyHint: 'No wallets yet.' });
    }
    if (step === 'awaiting_confirm') {
      return telegramMenus.exportKeyWarning({ walletLabel: data.walletLabel });
    }
  }
  return telegramMenus.mainMenu({});
}

function retryStepForField(error) {
  const field = error.issues?.[0]?.field;
  if (field === 'label') return 'awaiting_label';
  if (field === 'privateKey' || field === 'seedPhrase') return 'awaiting_key';
  if (field === 'chain') return 'awaiting_chain';
  return null;
}

// Entry point for /mint, /batch, and the "Mint" menu button. With no contract address yet, starts
// the guided flow at awaiting_contract. With one (typed inline, or sent as the awaiting_contract
// reply), validates it and derives which supported chain it's actually deployed on before moving
// to the wallet picker -- multi picks multiple wallets (batch), single picks exactly one (mint).
async function startMintFlow({ chatId, messageId, userId, multi, contractAddressInput }) {
  const send = payload => tgUpdate(chatId, messageId, payload);
  if (!contractAddressInput) {
    telegramFlowState.start('telegram', chatId, 'mint_guided', 'awaiting_contract', { multi });
    return send(renderFlowStep('mint_guided', 'awaiting_contract'));
  }
  if (!ethers.isAddress(contractAddressInput)) {
    return send({ text: 'That does not look like a valid contract address. Try again with /mint <contract> or /batch <contract>.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  const chain = await detectContractChain({ providerService, supportedChains: CONFIG.supportedChains, contractAddress: contractAddressInput });
  if (!chain) {
    return send({ text: 'Could not find this contract on any supported chain. Double-check the address.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  const data = { multi, contractAddress: contractAddressInput, chain, selectedWallets: [] };
  telegramFlowState.start('telegram', chatId, 'mint_guided', 'awaiting_wallet', data);
  // A single wallet has nothing to pick between -- asking anyway is a tap that teaches the user
  // nothing, and /start already creates that one wallet automatically for a brand-new user, so
  // this is the common case, not an edge case.
  const wallets = botCommands.wallets(userId);
  if (!multi && wallets.length === 1) {
    return advanceFromWalletSelection(chatId, messageId, userId, { data }, [wallets[0].label]);
  }
  return send(renderFlowStep('mint_guided', 'awaiting_wallet', { userId, data }));
}

// Once wallet(s) are picked (single tap for /mint, Continue for /batch), resolve price from the
// contract; only fall back to asking when the resolver genuinely can't determine it.
async function advanceFromWalletSelection(chatId, messageId, userId, flow, selectedWallets) {
  const resolved = await contractValueResolver.resolve(flow.data.chain, flow.data.contractAddress);
  if (resolved.price) {
    const priceETH = Number(ethers.formatEther(BigInt(resolved.price.value)));
    const data = { ...flow.data, selectedWallets, priceETH, priceUnknown: false };
    telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
    return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_confirm', { userId, data }));
  }
  // Nothing to probe via the plain mint(uint256) assumption -- try SeaDrop before falling back to
  // asking the user to type a price by hand. A price they'd type here would just be discarded
  // anyway once executeMint recomputes it from the discovered PublicDrop, so skip straight to
  // confirmation when it's already known.
  const seaDrop = await seaDropDiscoveryService.resolve(flow.data.chain, flow.data.contractAddress);
  if (seaDrop.address && seaDrop.publicDrop) {
    const priceETH = Number(ethers.formatEther(BigInt(seaDrop.publicDrop.mintPriceWei)));
    const data = { ...flow.data, selectedWallets, priceETH, priceUnknown: false };
    telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
    return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_confirm', { userId, data }));
  }
  const data = { ...flow.data, selectedWallets };
  telegramFlowState.advance('telegram', chatId, 'awaiting_price', data);
  return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_price', { userId, data }));
}

async function finishMintExecution(chatId, messageId, userId, flowData) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  try {
    commandRateLimiter.check('telegram', userId, flowData.multi ? 'batch-mint' : 'mint');
    if (flowData.multi) {
      const results = await botCommands.batchMint(userId, { walletLabels: flowData.selectedWallets,
        contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: 1, priceETH: flowData.priceETH });
      telegramFlowState.clear('telegram', chatId);
      return tgUpdate(chatId, messageId, { text: `✅ Batch complete: ${results.length} wallet transaction(s).`, replyMarkup: backToMenu });
    }
    const result = await botCommands.mint(userId, { walletLabel: flowData.selectedWallets[0],
      contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: 1, priceETH: flowData.priceETH });
    telegramFlowState.clear('telegram', chatId);
    return tgUpdate(chatId, messageId, { text: `✅ Mint ${result.state}: ${result.txHash || result.intentId}`, replyMarkup: backToMenu });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return tgUpdate(chatId, messageId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: validationReply(error), replyMarkup: backToMenu });
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${error.message}`, replyMarkup: backToMenu });
    throw error;
  }
}

// Entry point for /send and the "Send" menu button. Single-wallet users (the common case, since
// /start already auto-creates one) skip straight to the amount prompt -- same TG-05 auto-select
// idiom startMintFlow already uses for wallet selection.
async function startSendFlow({ chatId, messageId, userId }) {
  const wallets = botCommands.wallets(userId);
  if (!wallets.length) {
    return tgUpdate(chatId, messageId, { text: 'No wallets yet. Create one first from the Wallets menu.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  if (wallets.length === 1) {
    const data = { walletLabel: wallets[0].label, chain: wallets[0].chain };
    telegramFlowState.start('telegram', chatId, 'send_guided', 'awaiting_amount', data);
    return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_amount', { userId, data }));
  }
  telegramFlowState.start('telegram', chatId, 'send_guided', 'awaiting_wallet', {});
  return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_wallet', { userId }));
}

// Once amount and destination are both known, resolve the actual gas cost via the same
// transactionEngine.preview() the dashboard's mint preview uses, so the one-tap confirm screen
// shows a real number rather than a guess -- and so a request that would fail the value/gas
// ceiling or insufficient-balance checks is caught here instead of at broadcast time.
async function advanceToSendConfirm(chatId, messageId, userId, flow, toAddress) {
  const owned = findOwnedWallet(DB, userId, flow.data.walletLabel);
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  if (!owned) {
    telegramFlowState.clear('telegram', chatId);
    return tgUpdate(chatId, messageId, { text: 'That wallet no longer exists.', replyMarkup: backToMenu });
  }
  try {
    const valueWei = ethers.parseEther(String(flow.data.amountETH));
    const simulation = await transactionEngine.preview({ userId, wallet: owned, chain: flow.data.chain,
      to: toAddress, valueWei, triggerSource: 'manual' });
    const data = { ...flow.data, toAddress, estimatedCostWei: simulation.estimatedCostWei.toString() };
    telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
    return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_confirm', { userId, data }));
  } catch (error) {
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${error.message}`, replyMarkup: backToMenu });
    throw error;
  }
}

async function finishSendExecution(chatId, messageId, userId, flowData) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  try {
    commandRateLimiter.check('telegram', userId, 'send');
    const result = await botCommands.send(userId, { walletLabel: flowData.walletLabel,
      toAddress: flowData.toAddress, amountETH: flowData.amountETH, chain: flowData.chain });
    telegramFlowState.clear('telegram', chatId);
    return tgUpdate(chatId, messageId, { text: `✅ Send ${result.state}: ${result.txHash || result.intentId}`, replyMarkup: backToMenu });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return tgUpdate(chatId, messageId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: validationReply(error), replyMarkup: backToMenu });
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${error.message}`, replyMarkup: backToMenu });
    throw error;
  }
}

// Entry point for /exportkey and the Wallets menu's "Export key" button. Every step here is
// button-only (no free-text capture needed) up to the explicit warning tap, unlike mint/send.
async function startExportKeyFlow({ chatId, messageId, userId }) {
  const wallets = botCommands.wallets(userId);
  if (!wallets.length) {
    return tgUpdate(chatId, messageId, { text: 'No wallets yet.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  if (wallets.length === 1) {
    const data = { walletLabel: wallets[0].label };
    telegramFlowState.start('telegram', chatId, 'export_guided', 'awaiting_confirm', data);
    return tgUpdate(chatId, messageId, renderFlowStep('export_guided', 'awaiting_confirm', { userId, data }));
  }
  telegramFlowState.start('telegram', chatId, 'export_guided', 'awaiting_wallet', {});
  return tgUpdate(chatId, messageId, renderFlowStep('export_guided', 'awaiting_wallet', { userId }));
}

// SEC-01. The decrypted key never touches telegramFlowState, never reaches log(), and lives only as
// a local variable for the one call that builds the self-destructing message below. The anchor
// message (this function's own tgUpdate) is a plain acknowledgement -- the key itself always goes
// out through tgSendSelfDestruct as its own distinct message, never through the shared flow anchor.
async function finishExportKeyExecution(chatId, messageId, userId, flowData, platformUserId) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  const audit = value => Promise.resolve(botSecurityRepository.record(value)).catch(error => log(`Security audit write failed: ${safeError(error)}`));
  try {
    exportKeyRateLimiter.check('telegram', userId, 'exportkey');
    const exported = await botCommands.exportWalletKeyRaw(userId, flowData.walletLabel);
    telegramFlowState.clear('telegram', chatId);
    await tgUpdate(chatId, messageId, { text: `✅ Key for *${exported.label}* sent below. It self-deletes in ${EXPORT_KEY_TTL_MS / 1000}s -- deletion is a courtesy, not a control.`, replyMarkup: backToMenu });
    await tgSendSelfDestruct(chatId, `🔑 <b>${exported.label}</b>\n<code>${exported.privateKey}</code>`, { parse_mode: 'HTML' });
    await audit({ userId, platform: 'telegram', platformUserId, contextId: String(chatId), command: 'exportkey', outcome: 'success', reason: 'key export delivered' });
  } catch (error) {
    if (error instanceof RateLimitError) {
      await audit({ userId, platform: 'telegram', platformUserId, contextId: String(chatId), command: 'exportkey', outcome: 'rate_limited', reason: 'export key rate limit exceeded' });
      return tgUpdate(chatId, messageId, { text: `Too many export attempts. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: validationReply(error), replyMarkup: backToMenu });
    throw error;
  }
}

function tgMenu(chatId, { text, replyMarkup, parseMode }) {
  if (!bot || !chatId) return Promise.resolve();
  return bot.sendMessage(chatId, String(text), { reply_markup: replyMarkup, parse_mode: parseMode }).catch(e => log('TG: '+safeError(e)));
}

function tgEditMenu(chatId, messageId, { text, replyMarkup, parseMode }) {
  if (!bot || !chatId || !messageId) return tgMenu(chatId, { text, replyMarkup, parseMode });
  return bot.editMessageText(String(text), { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup, parse_mode: parseMode })
    .catch(() => tgMenu(chatId, { text, replyMarkup, parseMode }));
}

// ── Telegram anchored-menu rendering ─────────────────────────
// Guided flows used to call tgMenu() (a brand-new sendMessage) on every step, so a single wallet
// import or mint left a trail of half a dozen separate bot bubbles behind in the chat -- including,
// worse, the user's own raw private-key message sitting in transit history. tgRender keeps exactly
// one live "menu" message per chat by editing it in place across an entire flow, only falling back
// to a new message when there's nothing left to edit (first message ever, or Telegram can no longer
// edit the old one). Unlike tgEditMenu, a failed edit here must NOT fall back to sending through
// itself -- tgRender needs to know the edit failed so it can send the replacement AND update the
// anchor, whereas tgEditMenu's callers already treat "sent a new message instead" as success.
const chatAnchors = new Map();

async function tgEditRaw(chatId, messageId, { text, replyMarkup, parseMode }) {
  if (!bot || !chatId || !messageId) return null;
  try {
    return await bot.editMessageText(String(text), { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup, parse_mode: parseMode });
  } catch {
    return null;
  }
}

async function tgRender(chatId, payload) {
  const anchor = chatAnchors.get(chatId);
  const edited = anchor && await tgEditRaw(chatId, anchor, payload);
  if (edited) return edited;
  const sent = await tgMenu(chatId, payload);
  if (sent?.message_id) chatAnchors.set(chatId, sent.message_id);
  return sent;
}

// Guided-flow steps triggered by a button tap always have a messageId to edit in place; the same
// steps reached by auto-advancing past a skipped step (e.g. the single-wallet auto-select below,
// which never renders a wallet-picker message to edit) do not. Falling back to tgRender rather than
// tgEditMenu's own bare tgMenu fallback keeps that case anchored too, instead of spawning a new
// message the moment a flow happens to skip a step.
function tgUpdate(chatId, messageId, payload) {
  return messageId ? tgEditMenu(chatId, messageId, payload) : tgRender(chatId, payload);
}

// Best-effort cleanup of the user's own free-text flow reply (a wallet label, a private key, a
// contract address, a typed price) once it's been consumed -- most valuable for the private-key
// import step, where leaving the key sitting in chat history is a real exposure, not just clutter.
// Telegram only allows a bot to delete a private-chat message within 48 hours, so failures here
// (older messages, group chats) are expected and safe to swallow.
function tgDeleteUserMessage(msg) {
  if (!bot || !msg?.chat?.id || !msg?.message_id) return;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
}

const EXPORT_KEY_TTL_MS = 30_000;

// SEC-01: a distinct, non-anchored message (never tgRender's shared per-chat anchor -- the key
// must not become the content of a message that anything else could later edit or that could
// outlive its own timer) that deletes itself shortly after being sent. protect_content blocks
// Telegram's own forward/save affordances and disable_notification keeps the key out of a
// notification preview -- neither stops a screenshot, and deletion here is a courtesy, not a
// control: the key already transited Telegram's servers once it was sent.
async function tgSendSelfDestruct(chatId, text, { ttlMs = EXPORT_KEY_TTL_MS, ...options } = {}) {
  if (!bot || !chatId) return null;
  const sent = await bot.sendMessage(chatId, text, { protect_content: true, disable_notification: true, ...options });
  setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), ttlMs).unref();
  return sent;
}

async function handleFlowTextMessage(msg) {
  if (!msg.text || msg.text.startsWith('/')) return;
  let context;
  try { context = verifyTelegramContext(msg); } catch { return; }
  let userId;
  try {
    userId = await identity.resolveOrCreate('telegram', context.platformUserId);
    await governance.checkAccountStatus(userId);
  } catch { return; }
  const chatId = msg.chat.id;
  const flow = telegramFlowState.get('telegram', chatId);
  if (!flow) return;
  if (flow.pendingCancel) { tgDeleteUserMessage(msg); tgRender(chatId, telegramMenus.confirmCancelPrompt(FLOW_LABELS[flow.flow] || flow.flow)); return; }
  const isTextStep = (flow.flow === 'wallet_create' && flow.step === 'awaiting_label')
    || (flow.flow === 'wallet_import' && (flow.step === 'awaiting_label' || flow.step === 'awaiting_key'))
    || (flow.flow === 'mint_guided' && (flow.step === 'awaiting_contract' || flow.step === 'awaiting_price'))
    || (flow.flow === 'send_guided' && (flow.step === 'awaiting_amount' || flow.step === 'awaiting_destination'));
  if (!isTextStep) { tgDeleteUserMessage(msg); tgRender(chatId, { text: 'Please use the buttons above, or tap Cancel.', replyMarkup: cancelOnlyKeyboard() }); return; }

  // Consumed as flow input from here on -- clear it immediately rather than after a successful
  // outcome, so a private key or any other sensitive reply never lingers in chat history even if
  // validation later rejects it.
  tgDeleteUserMessage(msg);
  const value = msg.text.trim();
  if (flow.step === 'awaiting_label') {
    if (!value || value.length > 64) { tgRender(chatId, { text: 'Label must be 1-64 characters. Try again.', replyMarkup: cancelOnlyKeyboard() }); return; }
    telegramFlowState.advance('telegram', chatId, 'awaiting_chain', { label: value });
    tgRender(chatId, renderFlowStep(flow.flow, 'awaiting_chain'));
    return;
  }
  if (flow.step === 'awaiting_key') {
    try {
      commandRateLimiter.check('telegram', userId, 'importwallet');
      const wallet = await botCommands.importWallet(userId, { label: flow.data.label, chain: flow.data.chain, privateKey: value });
      telegramFlowState.clear('telegram', chatId);
      tgRender(chatId, { text: `✅ Wallet *${wallet.label}* imported at \`${wallet.address}\`.\n\n⚠️ Not recommended going forward: prefer /createwallet for new wallets.`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]) });
    } catch (error) {
      if (error instanceof ValidationError) {
        const retryStep = retryStepForField(error);
        if (retryStep) {
          telegramFlowState.advance('telegram', chatId, retryStep, {});
          const prompt = renderFlowStep(flow.flow, retryStep);
          tgRender(chatId, { text: `${validationReply(error)}\n\n${prompt.text}`, replyMarkup: prompt.replyMarkup });
          return;
        }
        telegramFlowState.clear('telegram', chatId);
        tgRender(chatId, { text: validationReply(error), replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
        return;
      }
      if (error instanceof RateLimitError) {
        tgRender(chatId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`, replyMarkup: cancelOnlyKeyboard() });
        return;
      }
      telegramFlowState.clear('telegram', chatId);
      log(`Telegram guided wallet import failed: ${safeError(error)}`);
      tgRender(chatId, { text: 'Import failed safely. Please try again from the Wallets menu.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
    }
    return;
  }
  if (flow.flow === 'mint_guided' && flow.step === 'awaiting_contract') {
    await startMintFlow({ chatId, messageId: null, userId, multi: flow.data.multi, contractAddressInput: value });
    return;
  }
  if (flow.flow === 'mint_guided' && flow.step === 'awaiting_price') {
    const priceETH = Number(value);
    if (!Number.isFinite(priceETH) || priceETH < 0) {
      tgRender(chatId, { text: 'Send a valid non-negative number.', replyMarkup: cancelOnlyKeyboard() });
      return;
    }
    const data = { ...flow.data, priceETH, priceUnknown: true };
    telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
    tgRender(chatId, renderFlowStep('mint_guided', 'awaiting_confirm', { userId, data }));
    return;
  }
  if (flow.flow === 'send_guided' && flow.step === 'awaiting_amount') {
    const amountETH = Number(value);
    if (!Number.isFinite(amountETH) || amountETH <= 0) {
      tgRender(chatId, { text: 'Send a positive number.', replyMarkup: cancelOnlyKeyboard() });
      return;
    }
    const data = { ...flow.data, amountETH };
    telegramFlowState.advance('telegram', chatId, 'awaiting_destination', data);
    tgRender(chatId, renderFlowStep('send_guided', 'awaiting_destination', { userId, data }));
    return;
  }
  if (flow.flow === 'send_guided' && flow.step === 'awaiting_destination') {
    if (!ethers.isAddress(value)) {
      tgRender(chatId, { text: 'That does not look like a valid address. Try again.', replyMarkup: cancelOnlyKeyboard() });
      return;
    }
    await advanceToSendConfirm(chatId, null, userId, flow, value);
  }
}

function withTelegramCallback(handler) {
  return async query => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    let context, userId = null;
    const audit=value=>Promise.resolve(botSecurityRepository.record(value)).catch(error=>log(`Security audit write failed: ${safeError(error)}`));
    try {
      context = verifyTelegramContext({ from: query.from, chat: query.message?.chat });
      userId = await identity.resolveOrCreate('telegram', context.platformUserId);
      await governance.checkAccountStatus(userId);
      bot.answerCallbackQuery(query.id).catch(() => {});
      // A button tap is always on the chat's current live message, whether or not it started life
      // as a tgRender() anchor -- keep the anchor pointed at it so a free-text reply that follows
      // (e.g. typing a price after tapping through the mint flow) edits this same message instead
      // of spawning a new one.
      if (messageId) chatAnchors.set(chatId, messageId);

      const data = query.data || '';
      const activeFlow = telegramFlowState.get('telegram', chatId);
      const isCancelControl = data === 'flow:cancel:confirm' || data === 'flow:cancel:resume'
        || data === 'confirm:pending' || data === 'cancel:pending';
      if (activeFlow && !isCancelControl) {
        const allowed = FLOW_CONTINUATION_PREFIXES[activeFlow.flow] || [];
        if (!allowed.some(prefix => data.startsWith(prefix))) {
          telegramFlowState.markPendingCancel('telegram', chatId);
          await tgEditMenu(chatId, messageId, telegramMenus.confirmCancelPrompt(FLOW_LABELS[activeFlow.flow] || activeFlow.flow));
          return;
        }
      }
      if (data === 'flow:cancel:confirm') {
        telegramFlowState.clear('telegram', chatId);
        await tgEditMenu(chatId, messageId, telegramMenus.mainMenu({ isOwner: await governanceRepository.isOwner(userId) }));
        return;
      }
      if (data === 'flow:cancel:resume') {
        const flow = telegramFlowState.clearPendingCancel('telegram', chatId);
        await tgEditMenu(chatId, messageId, flow ? renderFlowStep(flow.flow, flow.step, { userId, data: flow.data }) : telegramMenus.mainMenu({ isOwner: await governanceRepository.isOwner(userId) }));
        return;
      }
      if (data === 'confirm:pending' || data === 'cancel:pending') {
        const backToMenu = telegramMenus.mainMenu({ isOwner: await governanceRepository.isOwner(userId) }).replyMarkup;
        const pending = takePendingConfirmation(chatId);
        if (!pending) {
          await tgEditMenu(chatId, messageId, { text: 'That confirmation expired or was already handled. Run the command again if needed.', replyMarkup: backToMenu });
          return;
        }
        if (data === 'cancel:pending') {
          await tgEditMenu(chatId, messageId, { text: 'Cancelled.', replyMarkup: backToMenu });
          return;
        }
        const resultText = await pending.run();
        await tgEditMenu(chatId, messageId, { text: resultText, replyMarkup: backToMenu });
        return;
      }

      await handler(query, userId, { chatId, messageId });
    } catch (error) {
      if (error instanceof ValidationError) { tg(chatId, validationReply(error)); return; }
      if (error instanceof AccountBlockedError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'account_blocked',reason:error.message});
        tg(chatId, `⛔ Your account is ${error.status}${error.reason ? `: ${error.reason}` : ''}. Contact the project owner if you believe this is a mistake.`);
        return;
      }
      if (error instanceof AuthorizationError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'unauthorized',reason:error.message});
        tg(chatId, '❌ Owner access required.');
        return;
      }
      if (error instanceof RateLimitError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'rate_limited',reason:error.message});
        tg(chatId, `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`);
        return;
      }
      if (error instanceof BotContextError) {
        await audit({platform:'telegram',platformUserId:query.from?.id,contextId:query.message?.chat?.id,
          command:commandName(query.data),outcome:'invalid_context',reason:error.message});
        return;
      }
      if (error instanceof ProofResolutionError) { tg(chatId, `❌ ${error.message}`); return; }
      log(`Telegram callback failed: ${safeError(error)}`);
      tg(chatId, 'Action failed safely. Please try again.');
    }
  };
}

function withTelegramUser(handler) {
  return async (msg, match) => {
    let context,userId=null;
    const audit=value=>Promise.resolve(botSecurityRepository.record(value)).catch(error=>log(`Security audit write failed: ${safeError(error)}`));
    try {
      context=verifyTelegramContext(msg);
      userId=await identity.resolveOrCreate('telegram',context.platformUserId);
      await governance.checkAccountStatus(userId);
      const activeFlow=telegramFlowState.get('telegram',context.contextId);
      if(activeFlow) {
        telegramFlowState.markPendingCancel('telegram',context.contextId);
        await tgRender(msg.chat.id, telegramMenus.confirmCancelPrompt(FLOW_LABELS[activeFlow.flow]||activeFlow.flow));
        return;
      }
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
      if (error instanceof AccountBlockedError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'account_blocked',reason:error.message});
        tg(msg.chat.id, `⛔ Your account is ${error.status}${error.reason ? `: ${error.reason}` : ''}. Contact the project owner if you believe this is a mistake.`);
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
      if (error instanceof TransactionSafetyError) {
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
  // Milestone 15a: register the command list so Telegram's "/" autocomplete is always populated,
  // instead of relying on users remembering exact command syntax.
  bot.setMyCommands([
    { command: 'start', description: 'Open the main menu' },
    { command: 'mint', description: 'Mint from a contract' },
    { command: 'send', description: 'Send funds to an address' },
    { command: 'wallets', description: 'List your wallets' },
    { command: 'address', description: 'Get your wallet address' },
    { command: 'createwallet', description: 'Generate and encrypt a new wallet' },
    { command: 'importwallet', description: 'Import an existing wallet (not recommended)' },
    { command: 'removewallet', description: 'Remove a wallet' },
    { command: 'exportkey', description: 'Export a wallet\'s private key' },
    { command: 'mintnow', description: 'Mint immediately' },
    { command: 'mintcall', description: 'Mint via raw validated call JSON' },
    { command: 'mintpresets', description: 'List saved mint presets' },
    { command: 'tasks', description: 'List scheduled mint tasks' },
    { command: 'snipers', description: 'List post-confirmation copy snipers' },
    { command: 'watch', description: 'Manage social watch rules' },
    { command: 'activity', description: 'Recent mint activity' },
    { command: 'gas', description: 'Live chain fee data' },
    { command: 'stats', description: 'Account statistics' },
    { command: 'mode', description: 'Switch transaction mode preset' },
    { command: 'link', description: 'Get a code to link Discord or the dashboard' },
    { command: 'admin', description: 'Owner-only governance actions' },
    { command: 'help', description: 'Show the main menu' },
  ]).catch(error => log(`Failed to register Telegram command list: ${safeError(error)}`));

  bot.on('message', msg => {
    if(msg.text?.startsWith('/')&&!msg.from?.id) log('Telegram command without sender ignored');
    handleFlowTextMessage(msg).catch(error => log(`Telegram flow text handling failed: ${safeError(error)}`));
  });

  bot.on('callback_query', withTelegramCallback(async (query, userId, { chatId, messageId }) => {
    const data = query.data || '';
    const ownerFlag = async () => governanceRepository.isOwner(userId);

    if (data === 'menu:main') return tgEditMenu(chatId, messageId, telegramMenus.mainMenu({ isOwner: await ownerFlag() }));
    if (data === 'menu:wallets') return tgEditMenu(chatId, messageId, telegramMenus.walletsMenu());
    if (data === 'menu:settings') return tgEditMenu(chatId, messageId, telegramMenus.settingsMenu({ isOwner: await ownerFlag() }));
    if (data === 'menu:mint') return startMintFlow({ chatId, messageId, userId, multi: false, contractAddressInput: null });
    if (data === 'menu:send') return startSendFlow({ chatId, messageId, userId });
    if (data === 'menu:exportkey') return startExportKeyFlow({ chatId, messageId, userId });
    if (data === 'menu:tasks') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Tasks', 'Use /tasks to list, /canceltask, /pausetask, /resumetask, or /retrytask <id>.'));
    if (data === 'menu:snipers') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Snipers', 'Use /snipers to list, /updatesniper <id> <JSON> to edit.'));
    if (data === 'menu:watch') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Watch rules', 'Use /watch add|edit|disable|remove|list.'));
    if (data === 'menu:activity') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Activity', 'Use /activity to see recent mint activity.'));
    if (data === 'menu:gas') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Gas', 'Use /gas <chain> for live fee data.'));
    if (data === 'menu:mode') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Transaction mode', 'Use /mode <preset> CONFIRM to switch presets.'));
    if (data === 'menu:admin') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Admin', 'Use /admin <action> CONFIRM. Owner-only.'));

    if (data === 'link:generate') {
      const link = await identity.createLinkCode(userId);
      // Reachable from both the main menu and Settings now, so "back" always returns to the top
      // level rather than assuming Settings was the entry point.
      return tgEditMenu(chatId, messageId, { text: `🔗 <b>Account link code:</b> <code>${link.code}</code>\n\nTap the code to copy it. Expires in 5 minutes and can be used once. Enter it on the dashboard, or use the equivalent link command on another platform.`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to menu', 'menu:main')]]), parseMode: 'HTML' });
    }

    if (data === 'wallet:list') {
      const wallets = botCommands.wallets(userId);
      if (!wallets.length) return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Wallets', 'No wallets yet. Go back and tap Create wallet.'));
      const summary = await walletSummaryHtml(userId);
      return tgEditMenu(chatId, messageId, { text: `<b>Wallets (${wallets.length})</b>\n\n${summary}`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    }

    if (data === 'wallet:create:start') {
      telegramFlowState.start('telegram', chatId, 'wallet_create', 'awaiting_label');
      return tgEditMenu(chatId, messageId, renderFlowStep('wallet_create', 'awaiting_label'));
    }
    if (data === 'wallet:import:start') {
      telegramFlowState.start('telegram', chatId, 'wallet_import', 'awaiting_label');
      return tgEditMenu(chatId, messageId, renderFlowStep('wallet_import', 'awaiting_label'));
    }

    if (data.startsWith('flow:chain:')) {
      const chain = data.slice('flow:chain:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow) return tgEditMenu(chatId, messageId, telegramMenus.mainMenu({ isOwner: await ownerFlag() }));
      if (flow.flow === 'wallet_create') {
        try {
          const wallet = await botCommands.createWallet(userId, { label: flow.data.label, chain });
          telegramFlowState.clear('telegram', chatId);
          return tgEditMenu(chatId, messageId, { text: `✅ Wallet *${wallet.label}* generated securely.\nAddress: \`${wallet.address}\`\nChain: ${wallet.chain}\n\nFund this address to use it. The private key was encrypted at creation and never leaves the server.`,
            replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]) });
        } catch (error) {
          if (error instanceof ValidationError) {
            const retryStep = retryStepForField(error) || 'awaiting_label';
            telegramFlowState.advance('telegram', chatId, retryStep, {});
            const prompt = renderFlowStep('wallet_create', retryStep);
            return tgEditMenu(chatId, messageId, { text: `${validationReply(error)}\n\n${prompt.text}`, replyMarkup: prompt.replyMarkup });
          }
          telegramFlowState.clear('telegram', chatId);
          throw error;
        }
      }
      if (flow.flow === 'wallet_import') {
        telegramFlowState.advance('telegram', chatId, 'awaiting_key', { chain });
        return tgEditMenu(chatId, messageId, renderFlowStep('wallet_import', 'awaiting_key'));
      }
      return;
    }

    if (data.startsWith('flow:walletpick:')) {
      const label = data.slice('flow:walletpick:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided') return;
      return advanceFromWalletSelection(chatId, messageId, userId, flow, [label]);
    }
    if (data.startsWith('flow:wallettoggle:')) {
      const label = data.slice('flow:wallettoggle:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided') return;
      const current = flow.data.selectedWallets || [];
      const next = current.includes(label) ? current.filter(item => item !== label) : [...current, label];
      const data2 = { ...flow.data, selectedWallets: next };
      telegramFlowState.advance('telegram', chatId, 'awaiting_wallet', data2);
      return tgEditMenu(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_wallet', { userId, data: data2 }));
    }
    if (data === 'flow:walletcontinue') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided' || !flow.data.selectedWallets?.length) return;
      return advanceFromWalletSelection(chatId, messageId, userId, flow, flow.data.selectedWallets);
    }
    if (data === 'flow:mintconfirm') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided') return;
      return finishMintExecution(chatId, messageId, userId, flow.data);
    }

    if (data.startsWith('flow:sendwalletpick:')) {
      const label = data.slice('flow:sendwalletpick:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'send_guided') return;
      const owned = botCommands.wallets(userId).find(w => w.label === label);
      if (!owned) return;
      const flowData = { walletLabel: owned.label, chain: owned.chain };
      telegramFlowState.advance('telegram', chatId, 'awaiting_amount', flowData);
      return tgEditMenu(chatId, messageId, renderFlowStep('send_guided', 'awaiting_amount', { userId, data: flowData }));
    }
    if (data === 'flow:sendconfirm') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'send_guided') return;
      return finishSendExecution(chatId, messageId, userId, flow.data);
    }

    if (data.startsWith('flow:exportwalletpick:')) {
      const label = data.slice('flow:exportwalletpick:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'export_guided') return;
      const owned = botCommands.wallets(userId).find(w => w.label === label);
      if (!owned) return;
      const flowData = { walletLabel: owned.label };
      telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', flowData);
      return tgEditMenu(chatId, messageId, renderFlowStep('export_guided', 'awaiting_confirm', { userId, data: flowData }));
    }
    if (data === 'flow:exportconfirm') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'export_guided') return;
      return finishExportKeyExecution(chatId, messageId, userId, flow.data, String(query.from.id));
    }

    if (data === 'wallet:balance:pick') {
      return tgEditMenu(chatId, messageId, telegramMenus.walletPicker(botCommands.wallets(userId), { prefix:'wallet:balance', emptyHint:'No wallets yet. Create one first.' }));
    }
    if (data.startsWith('wallet:balance:') && data !== 'wallet:balance:pick') {
      const label = data.slice('wallet:balance:'.length);
      const result = await botCommands.walletBalance(userId, label);
      const lines = result.balances.map(b => `${CHAINS[b.chain]?.name || b.chain}: ${b.balance ?? 'unavailable'} ${b.symbol || ''}`).join('\n');
      return tgEditMenu(chatId, messageId, { text: `<b>${result.label}</b>\n<code>${result.address}</code>\n${lines}`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    }

    // Only reached from /address's own picker (no menu entry point -- the point of /address is to
    // skip menu traversal entirely; the wallets menu's "List wallets" already shows every address).
    if (data.startsWith('wallet:address:pick:')) {
      const label = data.slice('wallet:address:pick:'.length);
      const owned = botCommands.wallets(userId).find(w => w.label === label);
      if (!owned) return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Wallets', 'That wallet no longer exists.'));
      return tgEditMenu(chatId, messageId, { text: `<b>${owned.label}</b>\n<code>${owned.address}</code>`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    }

    if (data === 'wallet:remove:pick') {
      return tgEditMenu(chatId, messageId, telegramMenus.walletPicker(botCommands.wallets(userId), { prefix:'wallet:remove:pick', emptyHint:'No wallets yet.' }));
    }
    if (data.startsWith('wallet:remove:pick:')) {
      const label = data.slice('wallet:remove:pick:'.length);
      return tgEditMenu(chatId, messageId, telegramMenus.confirmRemoveWallet(label));
    }
    if (data.startsWith('wallet:remove:do:')) {
      const label = data.slice('wallet:remove:do:'.length);
      await botCommands.removeWallet(userId, label);
      return tgEditMenu(chatId, messageId, { text: `🗑️ Wallet *${label}* removed.`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]) });
    }
  }));

  // Shared by /start, /wallets, and the wallet:list menu button so the three surfaces never drift:
  // full address in an HTML <code> block -- Telegram's actual tap-to-copy affordance, which the
  // `backtick` Markdown these previously used never enabled since none of these call sites set
  // parse_mode -- plus the live per-chain balance from walletBalance's cache (TG-08).
  async function walletSummaryHtml(userId) {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return 'No wallets yet.';
    const blocks = await Promise.all(wallets.map(async w => {
      const { balances } = await botCommands.walletBalance(userId, w.label);
      const lines = balances.map(b => `${CHAINS[b.chain]?.name || b.chain}: ${b.balance ?? 'unavailable'} ${b.symbol || ''}`).join('\n');
      return `<b>${w.label}</b>\n<code>${w.address}</code>\n${lines}`;
    }));
    return blocks.join('\n\n');
  }

  const WELCOME_TEXT = `gm. i mint things.

here's the short version:

/mint — mint from a contract
/batch — mint across multiple wallets
/send — send funds to an address
/address — get your wallet address
/help — this again

send /mint with a contract address to get going.`;

  bot.onText(/^\/(?:start|help)(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const isStart = msg.text.startsWith('/start');
    if (isStart && botCommands.wallets(userId).length === 0) {
      try { await botCommands.createWallet(userId, { label: 'wallet-1', chain: CONFIG.supportedChains[0] }); }
      catch (error) { log(`Auto wallet creation on /start failed: ${safeError(error)}`); }
    }
    const menu = telegramMenus.mainMenu({ isOwner: await governanceRepository.isOwner(userId) });
    if (!isStart) return tgRender(msg.chat.id, { text: menu.text, replyMarkup: menu.replyMarkup });
    const summary = await walletSummaryHtml(userId);
    tgRender(msg.chat.id, { text: `${WELCOME_TEXT}\n\n${summary}\n\n${menu.text}`, replyMarkup: menu.replyMarkup, parseMode: 'HTML' });
  }));

  bot.onText(/^\/address(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return tg(msg.chat.id, 'No wallets yet. /wallets to create one.');
    if (wallets.length === 1) {
      return tg(msg.chat.id, `<b>${wallets[0].label}</b>\n<code>${wallets[0].address}</code>`, { parse_mode: 'HTML' });
    }
    tgRender(msg.chat.id, telegramMenus.walletPicker(wallets, { prefix: 'wallet:address:pick', emptyHint: 'No wallets yet.' }));
  }));

  // /mintnow is the same immediate, auto-detecting mint as /mint -- same handler, just the name a
  // user reaching for "mint right now" is more likely to type. commandName() reads the literal
  // word from msg.text, so /mintnow still gets its own extra rate-limit check in withTelegramUser
  // even though both commands share this handler.
  bot.onText(/^\/(?:mint|mintnow)(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match, userId) => {
    await startMintFlow({ chatId: msg.chat.id, messageId: null, userId, multi: false, contractAddressInput: match[1] || null });
  }));

  bot.onText(/^\/batch(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match, userId) => {
    await startMintFlow({ chatId: msg.chat.id, messageId: null, userId, multi: true, contractAddressInput: match[1] || null });
  }));

  bot.onText(/^\/send(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    await startSendFlow({ chatId: msg.chat.id, messageId: null, userId });
  }));

  bot.onText(/^\/exportkey(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    await startExportKeyFlow({ chatId: msg.chat.id, messageId: null, userId });
  }));

  bot.onText(/^\/link(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const link = await identity.createLinkCode(userId);
    tg(msg.chat.id, `🔗 <b>Account link code:</b> <code>${link.code}</code>\n\nTap the code to copy it. Expires in 5 minutes and can be used once.`, { parse_mode: 'HTML' });
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
    const summary = await walletSummaryHtml(userId);
    tg(msg.chat.id, `⬡ <b>Wallets (${wallets.length})</b>\n\n${summary}`, { parse_mode: 'HTML' });
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

  bot.onText(/^\/watch(?:@\w+)?\s+remove\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const rule = (await botCommands.watchRules(userId)).find(item => item.id === id);
    if (!rule) return tg(msg.chat.id, 'Social watch rule not found. Use /watch list.');
    setPendingConfirmation(msg.chat.id, async () => {
      await botCommands.removeWatchRule(userId, id);
      return `✅ Social watch rule *${rule.name}* removed.`;
    });
    tgRender(msg.chat.id, { text: `Remove social watch rule *${rule.name}*? This cannot be undone.`, replyMarkup: confirmationKeyboard() });
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
    const result=await botCommands.confirmTrigger(userId,match[1],match[2]);
    tg(msg.chat.id,result.action==='rejected'?'Trigger rejected.':`✅ Triggered mint ${result.result.state}.`);
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

  bot.onText(/^\/canceltask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tg(msg.chat.id, 'Task not found. Use /tasks.');
    setPendingConfirmation(msg.chat.id, async () => {
      const cancelled = await botCommands.controlTask(userId, 'cancel', id);
      return `✅ Task *${cancelled.name}* cancelled.`;
    });
    tgRender(msg.chat.id, { text: `Cancel task *${task.name}*? This cannot be undone.`, replyMarkup: confirmationKeyboard() });
  }));

  bot.onText(/^\/pausetask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const task = await botCommands.controlTask(userId, 'pause', match[1]);
    tg(msg.chat.id, `⏸ Task *${task.name}* paused.`);
  }));

  bot.onText(/^\/resumetask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tg(msg.chat.id, 'Task not found. Use /tasks.');
    setPendingConfirmation(msg.chat.id, async () => {
      const resumed = await botCommands.controlTask(userId, 'resume', id);
      return `▶ Task *${resumed.name}* resumed.`;
    });
    tgRender(msg.chat.id, { text: `Resume task *${task.name}*?`, replyMarkup: confirmationKeyboard() });
  }));

  bot.onText(/^\/retrytask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tg(msg.chat.id, 'Task not found. Use /tasks.');
    setPendingConfirmation(msg.chat.id, async () => {
      const retried = await botCommands.controlTask(userId, 'retry', id);
      return `↻ Task *${retried.name}* queued for retry.`;
    });
    tgRender(msg.chat.id, { text: `Retry task *${task.name}*?`, replyMarkup: confirmationKeyboard() });
  }));

  bot.onText(/^\/removewallet(?:@\w+)?\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const label = match[1].trim();
    const owned = botCommands.wallets(userId).find(item => item.label === label);
    if (!owned) return tg(msg.chat.id, `Wallet "${label}" not found. Use /wallets.`);
    setPendingConfirmation(msg.chat.id, async () => {
      const removed = await botCommands.removeWallet(userId, owned.label);
      return `✅ Wallet *${removed}* removed.`;
    });
    tgRender(msg.chat.id, { text: `Remove wallet *${owned.label}*? This cannot be undone.`, replyMarkup: confirmationKeyboard() });
  }));

} else {
  log('⚠️  No TELEGRAM_BOT_TOKEN — Telegram disabled.');
}

const botCommands = createBotCommandService({
  storage,
  identity,
  broadcast: (userId, resource) => dashboardWebSockets.broadcastToUser(userId, {type:`${resource}.changed`}),
  schedulerRepository,
  providerService,
  contractValueResolver,
  seaDropDiscoveryService,
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
  mintService,
  governanceRepository,
  supportedChains: CONFIG.supportedChains,
  chains: CHAINS,
  encryptPrivateKey: encryptPK,
  getState: () => DB,
  ensureChainWatcher,
  previewMint:async({userId,wallet,prepared,gasGwei})=>mintExecution.preview({userId,wallet,prepared,
    gasPriceWei:gasGwei===undefined||gasGwei===null?undefined:ethers.parseUnits(String(gasGwei),'gwei')}),
  executePreparedMint:async({userId,wallet,prepared,gasGwei})=>{
    const intent=await mintExecution.executePrepared({userId,wallet,prepared,triggerSource:'manual',
      gasPriceWei:gasGwei===undefined||gasGwei===null?undefined:ethers.parseUnits(String(gasGwei),'gwei')});
    await recordMintActivity({ userId, wallet, quantity: previewQuantity(prepared.preview), intent, chain: wallet.chain });
    return intent;
  },
  executeMint: async ({ userId, wallet, request }) => {
    const intent = await executeMint({ wallet, contractAddr: request.contractAddress,
      qty: request.quantity, priceETH: request.priceETH, gasGwei: request.gasGwei,
      chain: request.chain, triggerSource: 'manual' });
    await recordMintActivity({ userId, wallet, quantity: request.quantity, intent, chain: request.chain });
    return intent;
  },
  // Unlike mint, a send has no contract/calldata to prepare -- calls transactionEngine.submit
  // directly (same pattern the sniper's blockchain-triggered copy path already uses at
  // executeTriggered above), which still applies the same spend caps, gas ceiling, and nonce queue.
  executeSend: async ({ userId, wallet, request }) => {
    const intent = await transactionEngine.submit({ userId, wallet, chain: request.chain,
      to: request.toAddress, valueWei: ethers.parseEther(String(request.amountETH)), triggerSource: 'manual',
      gasPriceWei: request.gasGwei === undefined || request.gasGwei === null ? undefined : ethers.parseUnits(String(request.gasGwei), 'gwei') });
    await logActivity(userId, 'success', `Sent ${request.amountETH} ${CHAINS[request.chain]?.sym || ''} to ${request.toAddress}`,
      wallet.label, intent, CHAINS[request.chain], { triggerSource: 'manual' });
    return intent;
  },
  // SEC-01. decryptPK/keyEncryption stay private to this module either way -- these are the only
  // two places outside transactionEngine's signing step that ever call it.
  exportRawKey: async ({ wallet }) => decryptPK(wallet),
  exportKeystore: async ({ wallet, password }) => new ethers.Wallet(decryptPK(wallet)).encrypt(password),
});
const dashboardApi=createDashboardApi({auth:dashboardAuth,identityRepository,commands:botCommands,
  securityAudit:botSecurityRepository,broadcast:(userId,message)=>dashboardWebSockets.broadcastToUser(userId,message),
  supportedChains:CONFIG.supportedChains,
  checkAccountStatus:userId=>governance.checkAccountStatus(userId),
  loginRateLimiter:createCommandRateLimiter({limit:5,windowMs:60_000}),
  exportKeyRateLimiter});

if (CONFIG.discordBotToken) {
  discordBot = createDiscordBot({ token: CONFIG.discordBotToken,
    applicationId: CONFIG.discordApplicationId, devGuildId: CONFIG.discordDevGuildId,
    identity, commands: botCommands, securityAudit:botSecurityRepository,rateLimiter:commandRateLimiter,log,
    isOwner: userId => governanceRepository.isOwner(userId),
    checkAccountStatus: userId => governance.checkAccountStatus(userId),
    supportedChains: CONFIG.supportedChains, chains: CHAINS });
  // Live push: skip the 30s social-watch poll for discord_channel rules by reacting
  // to the Gateway's messageCreate event directly. The scheduled poller keeps running
  // as a fallback, so a dropped Gateway connection never stops detection, just slows it.
  discordBot.client.on('messageCreate', message => {
    if (message.author?.bot || !message.content) return;
    socialWatchService.processLiveDiscordMessage({ platform:'discord', id:message.id, text:message.content,
      url:message.url, publishedAt:message.createdTimestamp, channelId:message.channelId })
      .catch(error => log(`Live discord watch dispatch failed: ${safeError(error)}`));
  });
} else {
  log('Discord disabled because credentials are not configured.');
}

// ── Task Scheduler ────────────────────────────────────────
// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(dashboardApi.securityHeaders);
mountDashboardRoutes(app,dashboardApi);
app.use('/api',(req,res)=>res.status(404).json({error:'API route not found'}));
app.use(dashboardApi.error);
app.use('/dashboard/assets',express.static(path.join(PROJECT_ROOT,'public','dashboard','assets'),{immutable:true,maxAge:'1y'}));
app.get(['/dashboard','/dashboard/*'],(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(PROJECT_ROOT,'public','dashboard','index.html'));});
app.use(express.static(path.join(PROJECT_ROOT,'public'),{setHeaders:(res,file)=>res.set('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=3600')}));

// ── API ───────────────────────────────────────────────────
const readinessService=createReadinessService({database:storage,providerService,
  chains:CONFIG.supportedChains,schedulerWorker,socialWatchWorker,retentionWorker,
  sniperHealth:()=>({status:'up',activeChains:Object.keys(chainWatchers).length,
    liveChains:Object.values(chainWatchers).filter(watcher=>watcher.mode()==='ws').length})});
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
    // Discord's login/command-registration must never abort the rest of startup -- Telegram, the
    // HTTP server (including /health and the dashboard), and every background worker are otherwise
    // independent of Discord, so a bad/revoked token or a transient Discord outage should degrade
    // only the Discord integration, the same way one chain's provider failure doesn't take down
    // another chain's sniper watcher.
    try {
      const discordUser = await discordBot.start();
      log(`Discord bot started as ${discordUser?.tag || discordUser?.id || 'configured application'}`);
    } catch (error) {
      log(`Discord bot failed to start, continuing without it: ${safeError(error)}`);
    }
  }
  schedulerWorker.start();
  socialWatchWorker.start();
  retentionWorker.start();
  log('Started social watch-rule worker');
  log('Started governance-group retention worker');
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
  schedulerWorker,socialWatchWorker,retentionWorker,webSocketHub:dashboardWebSockets,stopWatchers:()=>Object.keys(chainWatchers).forEach(chain=>{
    chainWatchers[chain].stop();delete chainWatchers[chain];
  }),pool,log});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>gracefulShutdown(signal)
  .then(()=>{process.exitCode=0;}).catch(error=>{log(`Shutdown failed: ${safeError(error)}`);process.exitCode=1;}));

start().catch(error => {
  log(`Startup failed: ${safeError(error)}`);
  process.exitCode = 1;
});

process.on('unhandledRejection', e => log('Rejection: '+safeError(e)));
// Per Node's own guidance, resuming normal operation after an uncaught exception is unsafe -- the
// process may be in a corrupted state (partially-unwound locks, listeners, in-flight writes). Best
// effort graceful shutdown (reusing the same path SIGINT/SIGTERM already use, which is idempotent),
// capped so a hung shutdown can't turn a crash into a silent, permanent freeze, then a hard exit so
// an external process manager restarts the service into a known-good state.
let crashing = false;
process.on('uncaughtException', e => {
  log('Exception: '+safeError(e));
  if (crashing) return;
  crashing = true;
  Promise.race([
    gracefulShutdown('uncaughtException'),
    new Promise(resolve => setTimeout(resolve, 5000).unref()),
  ]).finally(() => process.exit(1));
});
