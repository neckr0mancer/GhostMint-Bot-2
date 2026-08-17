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
const { createOpenSeaService } = require('./mint/openSeaService');
const { createPriceFeedService } = require('./mint/priceFeedService');
const { computeSeaDropValueWei } = require('./mint/seaDropCall');
const { SEADROP_MINT_SIGNATURE } = require('./mint/seaDropRegistry');
const { createSchedulerRepository } = require('./scheduler/schedulerRepository');
const { createSchedulerWorker } = require('./scheduler/schedulerWorker');
const { createSocialAdapters } = require('./social/adapters');
const { createSocialWatchRepository } = require('./social/socialWatchRepository');
const { createSocialWatchService } = require('./social/socialWatchService');
const { createSocialWatchWorker } = require('./social/socialWatchWorker');
const { createRetentionWorker } = require('./governance/retentionWorker');
const { createSocialUsageService, formatUsageSummary } = require('./social/usageService');
const { createFlowStateStore } = require('./telegram/flowState');
const { createPanelStore } = require('./telegram/panelState');
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
  escapeTelegramHtml, requireTextConfirmation,verifyTelegramContext } = require('./security/botSecurity');
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
const openSeaService = createOpenSeaService({
  apiKey: CONFIG.openSeaApiKey,
  repository: contractValueRepository,
});
const priceFeedService = createPriceFeedService();
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
  CONFIG.openSeaApiKey,
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
  notify:(userId,value)=>notifyUser(userId,`Trigger requires confirmation.\n<code>${escapeTelegramHtml(JSON.stringify(value.preview))}</code>\nRun /confirmtrigger ${value.requestId} CONFIRM to approve or REJECT to reject within 10 minutes.`),
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
    const prepared = await prepareMintCall({ contractAddress:request.contractAddress,
      walletAddress:wallet.address, chain:request.chain, quantity:request.quantity, priceETH:request.priceETH });
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
      await notifyUser(event.task.userId, `✅ Scheduled mint <b>${escapeTelegramHtml(event.task.name)}</b> confirmed.`);
    }
    if (['failure','failed'].includes(event.outcome)) {
      if (wallet) await logActivity(event.task.userId, 'fail', `Scheduled mint failed: ${event.task.name}`,
        wallet.label, event.intent?.txHash || null, CHAINS[wallet.chain],{triggerSource:'scheduled'});
      await notifyUser(event.task.userId, `❌ Scheduled mint <b>${escapeTelegramHtml(event.task.name)}</b> failed.`);
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
  await autoRecordPnl({ userId, wallet, quantity, intent });
}

// Every confirmed mint becomes its own P&L row automatically -- cost and gas are real numbers
// straight from the confirmed receipt (intent.valueWei / intent.actualNetworkCostWei), nothing
// guessed. Sale is left at 0 since there is no data source anywhere for actual resale proceeds --
// the owner (or a future sales watcher, once it detects a resale) fills that in later.
async function autoRecordPnl({ userId, wallet, quantity, intent }) {
  if (intent?.actualNetworkCostWei === undefined || intent?.actualNetworkCostWei === null) return;
  const costEth = Number(ethers.formatEther(intent.valueWei ?? 0n));
  const gasEth = Number(ethers.formatEther(intent.actualNetworkCostWei));
  const saved = await storage.addPnl({ userId, nm: `Minted ${quantity} NFT${quantity === 1 ? '' : 's'} — ${wallet.label}`,
    cost: costEth, sale: 0, gas: gasEth, net: -(costEth + gasEth), t: Date.now() });
  DB.pnl.unshift(saved);
  dashboardWebSockets.broadcastToUser(userId, { type: 'pnl.changed' });
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

// Shared by every mint-construction path (immediate mint via executeMint below, and the scheduler's
// executeTask above) so SeaDrop detection can never drift between "mint now" and "mint later" --
// previously executeTask duplicated this inline with a hardcoded 'mint(uint256)' signature, which
// meant a scheduled mint of a SeaDrop drop sent 0-value plain calldata to a contract that doesn't
// implement that signature at all (SeaDrop tokens route through a separate core contract; see
// seaDropCall.js). SeaDrop's live on-chain price is used when available so a task scheduled before
// the drop's public price was known still mints at the real price, not a stale/zero stored value.
async function prepareMintCall({ contractAddress, walletAddress, chain, quantity, priceETH }) {
  const seaDrop = await seaDropDiscoveryService.resolve(chain, contractAddress);
  if (seaDrop.address) {
    return mintService.prepare({
      contractAddress,
      methodSignature: SEADROP_MINT_SIGNATURE,
      seaDropAddress: seaDrop.address,
      arguments: [seaDrop.feeRecipient, '$wallet', quantity],
      walletAddress,
      valueWei: seaDrop.publicDrop
        ? computeSeaDropValueWei({ mintPriceWei: seaDrop.publicDrop.mintPriceWei, quantity })
        : ethers.parseEther(String(priceETH)) * BigInt(quantity),
      chain,
    });
  }
  return mintService.prepare({
    contractAddress,
    methodSignature: 'mint(uint256)',
    arguments: [quantity],
    walletAddress,
    valueWei: ethers.parseEther(String(priceETH)) * BigInt(quantity),
    chain,
  });
}

// Shared quick-mint landing point for every platform: Discord's /mint calls straight into this via
// botCommands.mint(), and Telegram's guided flow's final step (finishMintExecution) does the same.
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
  const prepared = await prepareMintCall({ contractAddress: request.contractAddress,
    walletAddress: wallet.address, chain: request.chain, quantity: request.quantity, priceETH: request.priceETH });
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
    await notifyUser(sniper.userId,`Blockchain trigger for <b>${escapeTelegramHtml(sniper.label)}</b> requires confirmation. Contract: <code>${sourceTx.to}</code>.\nRun /confirmtrigger ${request.id} CONFIRM to approve or REJECT to reject within 10 minutes.`);
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
      ? `✅ Post-confirmation copy <b>${escapeTelegramHtml(sniper.label)}</b> confirmed.`
      : `🎯 Post-confirmation copy <b>${escapeTelegramHtml(sniper.label)}</b>: ${escapeTelegramHtml(state)}${reason ? ` — ${escapeTelegramHtml(reason)}` : ''}${error ? ` — ${escapeTelegramHtml(safeError(error).slice(0,120))}` : ''}`);
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
    telegram: (platformUserId, message) => tg(platformUserId, message, { parse_mode: 'HTML' }),
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
const FLOW_LABELS = { wallet_create: 'creating a wallet', wallet_import: 'importing a wallet', mint_guided: 'minting', send_guided: 'sending funds', export_guided: 'exporting a private key', task_guided: 'scheduling a mint' };
const FLOW_CONTINUATION_PREFIXES = { wallet_create: ['flow:chain:'], wallet_import: ['flow:chain:'],
  mint_guided: ['flow:mintdetailscontinue', 'flow:mintqty:', 'flow:priceaccept', 'flow:pricemanual', 'flow:wallettoggle:', 'flow:walletpick:', 'flow:walletcontinue', 'flow:mintconfirm'],
  send_guided: ['flow:sendwalletpick:', 'flow:sendamount:', 'flow:sendconfirm'],
  export_guided: ['flow:exportwalletpick:', 'flow:exportconfirm'],
  // Shares flow:mintdetailscontinue with mint_guided -- the contract-details screen and its
  // Continue button are the same component either way; the callback handler branches on
  // flow.flow to decide whether "continue" means "go mint it" or "go schedule it". Also shares
  // flow:priceaccept/flow:pricemanual (Section G's OpenSea-price-accept step) the same way.
  task_guided: ['flow:mintdetailscontinue', 'flow:priceaccept', 'flow:pricemanual', 'flow:taskwalletpick:', 'flow:taskconfirm'] };

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
// Shared by mint_guided and task_guided's awaiting_price step: offers OpenSea's floor price as a
// one-tap accept when the contract itself doesn't expose a price but a floor is known (Section G),
// falling back to free-text entry either way -- typing a number always works regardless of which
// buttons are shown, same as before this existed.
function priceStepPayload(data) {
  const sym = CHAINS[data.chain]?.sym || 'native currency';
  if (data.displayPrice) {
    const usdSuffix = data.displayPrice.usd ? ` (~$${data.displayPrice.usd.toFixed(2)})` : '';
    return {
      text: `This contract does not expose a recognized price function. OpenSea suggests a floor price of <b>${data.displayPrice.eth} ${sym}</b>${usdSuffix}. Use this as the mint price, or enter one yourself?`,
      replyMarkup: telegramMenus.keyboard([
        [telegramMenus.button(`✅ Use ${data.displayPrice.eth} ${sym}`, 'flow:priceaccept')],
        [telegramMenus.button('✏️ Enter manually', 'flow:pricemanual')],
        [telegramMenus.button('❌ Cancel', 'flow:cancel:ask')],
      ]),
      parseMode: 'HTML',
    };
  }
  return { text: `This contract does not expose a recognized price function. Send the price per item in ${sym} (send 0 if it is free).`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
}

// Quick quantity buttons for a contract whose maxPerWallet allows more than 1 (Section G) --
// Telegram's guided flow otherwise always hardcoded quantity to 1 regardless of what a contract
// actually permitted.
function quantityStepPayload(data) {
  const max = Math.max(1, Math.min(Number(data.maxPerWallet) || 1, 100));
  const quick = [...new Set([1, 2, 5, max].filter(value => value <= max))];
  const row = quick.map(value => telegramMenus.button(value === max ? `Max (${max})` : String(value), `flow:mintqty:${value}`));
  return { text: `How many would you like to mint? (max ${max} per wallet). You can also type an exact number.`, replyMarkup: telegramMenus.keyboard([row, [telegramMenus.button('✏️ Enter manually', 'flow:mintqty:x')], [telegramMenus.button('❌ Cancel', 'flow:cancel:ask')]]), parseMode: 'HTML' };
}

function renderFlowStep(flow, step, { userId, data = {} } = {}) {
  if (flow === 'wallet_create') {
    if (step === 'awaiting_label') return { text: 'Send the label for your new wallet (letters, numbers, spaces, <code>.</code>, <code>_</code>, <code>-</code>).', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    if (step === 'awaiting_chain') return telegramMenus.chainPicker(CONFIG.supportedChains, CHAINS);
  }
  if (flow === 'wallet_import') {
    if (step === 'awaiting_label') return { text: 'Send the label for the wallet you are importing.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    if (step === 'awaiting_chain') return telegramMenus.chainPicker(CONFIG.supportedChains, CHAINS);
    if (step === 'awaiting_key') return { text: '⚠️ <b>Not recommended:</b> send the private key now. It passes through Telegram message transit and may remain in chat history or notification previews. Delete your message afterward if you can.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
  }
  if (flow === 'mint_guided') {
    if (step === 'awaiting_contract') return { text: 'Send the contract address to mint from.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    if (step === 'awaiting_details') {
      return telegramMenus.contractDetails({
        contractAddress: data.contractAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        isSeaDrop: data.isSeaDrop,
        priceETH: data.priceETH,
        priceUnknown: data.priceUnknown,
        maxSupply: data.maxSupply,
        maxPerWallet: data.maxPerWallet,
        startTime: data.startTime,
        collection: data.collection,
        soldOut: data.soldOut,
        displayPrice: data.displayPrice,
      });
    }
    if (step === 'awaiting_wallet') {
      const wallets = botCommands.wallets(userId);
      return data.multi
        ? telegramMenus.walletMultiPicker(wallets, data.selectedWallets || [], { emptyHint: 'No wallets yet. Create one first from the Wallets menu.' })
        : telegramMenus.walletPicker(wallets, { prefix: 'flow:walletpick', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' });
    }
    if (step === 'awaiting_quantity') return quantityStepPayload(data);
    if (step === 'awaiting_price') return priceStepPayload(data);
    if (step === 'awaiting_confirm') {
      return telegramMenus.mintConfirmation({
        contractAddress: data.contractAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        walletLabels: data.selectedWallets,
        quantity: data.quantity || 1,
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
      const sym = CHAINS[data.chain]?.sym || 'native currency';
      const prompt = `How much ${sym} do you want to send from <b>${escapeTelegramHtml(data.walletLabel)}</b>? You can also type an exact amount.`;
      if (!data.balanceWei) return { text: prompt, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
      const quickRow = [
        telegramMenus.button('Max', 'flow:sendamount:max'),
        telegramMenus.button('75%', 'flow:sendamount:75'),
        telegramMenus.button('50%', 'flow:sendamount:50'),
        telegramMenus.button('25%', 'flow:sendamount:25'),
      ];
      return { text: prompt, replyMarkup: telegramMenus.keyboard([quickRow, [telegramMenus.button('✏️ Enter manually', 'flow:sendamount:x')], [telegramMenus.button('❌ Cancel', 'flow:cancel:ask')]]), parseMode: 'HTML' };
    }
    if (step === 'awaiting_destination') {
      return { text: 'Send the destination address.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
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
  if (flow === 'task_guided') {
    if (step === 'awaiting_contract') return { text: 'Send the contract address to schedule a mint for.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    if (step === 'awaiting_details') {
      return telegramMenus.contractDetails({
        contractAddress: data.contractAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        isSeaDrop: data.isSeaDrop,
        priceETH: data.priceETH,
        priceUnknown: data.priceUnknown,
        maxSupply: data.maxSupply,
        maxPerWallet: data.maxPerWallet,
        startTime: data.startTime,
        collection: data.collection,
        soldOut: data.soldOut,
        displayPrice: data.displayPrice,
      });
    }
    if (step === 'awaiting_wallet') {
      return telegramMenus.walletPicker(botCommands.wallets(userId), { prefix: 'flow:taskwalletpick', emptyHint: 'No wallets yet. Create one first from the Wallets menu.' });
    }
    if (step === 'awaiting_price') return priceStepPayload(data);
    if (step === 'awaiting_name') return { text: 'Send a name for this scheduled mint.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    if (step === 'awaiting_time') {
      return { text: 'This contract\'s opening time is not known. Send the UTC date/time to mint at, including an explicit Z or offset, e.g. <code>2026-08-20T18:00:00Z</code>.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' };
    }
    if (step === 'awaiting_confirm') {
      return telegramMenus.taskConfirmation({
        name: data.name,
        contractAddress: data.contractAddress,
        chainLabel: CHAINS[data.chain]?.name || data.chain,
        walletLabel: data.walletLabel,
        mintTime: data.mintTime,
        autoDetectedTime: Boolean(data.startTime && new Date(data.mintTime).getTime() === data.startTime * 1000),
        priceETH: data.priceETH,
        priceUnknown: data.priceUnknown,
        displayPrice: data.displayPrice,
      });
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

// A user's currently-selected transaction-mode preset (Section C / Milestone 7a) is the only
// place "skip confirmation" is configured -- /mintnow reads it rather than having its own
// separate bypass toggle, so degen-mode behavior stays consistent everywhere it applies.
async function isVerificationBypassed(userId, chain) {
  const effective = await governanceRepository.getEffectiveGovernance(userId, chain);
  return effective.preset?.humanVerification === 'bypass';
}

// Entry point for /mint, /mintnow, /batch, and the "Mint" menu button. With no contract address
// yet, starts the guided flow at awaiting_contract. With one (typed inline, or sent as the
// awaiting_contract reply), runs the same full detection the dashboard's auto-detect uses (chain,
// SeaDrop vs plain mint, price, supply/per-wallet limits, SeaDrop opening time, OpenSea metadata)
// and shows it as its own step before wallet selection -- multi picks multiple wallets (batch),
// single picks exactly one (mint).
//
// oneShot (/mintnow only) means "skip confirmation," not "skip asking for things that aren't
// known yet" -- it only takes effect once the user has actually opted into a bypass-verification
// mode preset (isVerificationBypassed), and even then only the redundant final confirm tap is
// skipped: a missing wallet pick or unresolvable price is still asked for, same as /mint. With
// exactly one wallet and a known price -- the common case -- this reaches execution with zero taps.
async function startMintFlow({ chatId, messageId, userId, multi, contractAddressInput, oneShot = false }) {
  const send = payload => tgUpdate(chatId, messageId, payload);
  if (!contractAddressInput) {
    telegramFlowState.start('telegram', chatId, 'mint_guided', 'awaiting_contract', { multi, oneShot });
    return send(renderFlowStep('mint_guided', 'awaiting_contract'));
  }
  if (!ethers.isAddress(contractAddressInput)) {
    return send({ text: 'That does not look like a valid contract address. Try again with /mint <contract> or /batch <contract>.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  let detected;
  try {
    detected = await botCommands.detectMintContract(userId, { contractAddress: contractAddressInput, quantity: 1 });
  } catch (error) {
    if (error instanceof ValidationError) {
      return send({ text: 'Could not find this contract on any supported chain. Double-check the address.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
    }
    throw error;
  }
  const skipConfirm = oneShot && !multi && await isVerificationBypassed(userId, detected.chain);
  const data = {
    multi, contractAddress: contractAddressInput, chain: detected.chain, selectedWallets: [],
    isSeaDrop: detected.isSeaDrop,
    priceETH: detected.priceKnown ? Number(ethers.formatEther(BigInt(detected.valueWei))) : undefined,
    priceUnknown: !detected.priceKnown,
    maxSupply: detected.maxSupply, maxPerWallet: detected.maxPerWallet,
    startTime: detected.startTime, endTime: detected.endTime, collection: detected.collection,
    soldOut: detected.soldOut, displayPrice: detected.displayPrice,
    skipConfirm,
  };
  if (skipConfirm) {
    const wallets = botCommands.wallets(userId);
    if (wallets.length === 1 && !data.priceUnknown) {
      return finishMintExecution(chatId, messageId, userId, { ...data, selectedWallets: [wallets[0].label] });
    }
  }
  telegramFlowState.start('telegram', chatId, 'mint_guided', 'awaiting_details', data);
  return send(renderFlowStep('mint_guided', 'awaiting_details', { userId, data }));
}

// After the user has seen (and tapped through) the contract details, move on to wallet selection.
// A single wallet has nothing to pick between -- asking anyway is a tap that teaches the user
// nothing, and /start already creates that one wallet automatically for a brand-new user, so this
// is the common case, not an edge case.
// A contract allowing more than 1 per wallet asks how many before wallet selection; a max of 1 (or
// unknown) has nothing to ask, so it skips straight past this step exactly like it always did.
async function advanceFromDetails(chatId, messageId, userId, flow) {
  if (Number(flow.data.maxPerWallet) > 1) {
    telegramFlowState.advance('telegram', chatId, 'awaiting_quantity', flow.data);
    return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_quantity', { userId, data: flow.data }));
  }
  return advanceFromQuantity(chatId, messageId, userId, flow, 1);
}

// After the user has seen (and tapped through) the contract details and picked a quantity, move on
// to wallet selection. A single wallet has nothing to pick between -- asking anyway is a tap that
// teaches the user nothing, and /start already creates that one wallet automatically for a
// brand-new user, so this is the common case, not an edge case.
async function advanceFromQuantity(chatId, messageId, userId, flow, quantity) {
  const data = { ...flow.data, quantity };
  const wallets = botCommands.wallets(userId);
  if (!data.multi && wallets.length === 1) {
    return advanceFromWalletSelection(chatId, messageId, userId, { data }, [wallets[0].label]);
  }
  telegramFlowState.advance('telegram', chatId, 'awaiting_wallet', data);
  return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_wallet', { userId, data }));
}

// Once wallet(s) are picked (single tap for /mint, Continue for /batch): price was already
// resolved back in startMintFlow's details step, so this only needs to decide whether that
// resolution actually found a price (straight to confirm) or not (ask for one by hand).
async function advanceFromWalletSelection(chatId, messageId, userId, flow, selectedWallets) {
  const data = { ...flow.data, selectedWallets };
  if (data.priceUnknown) {
    telegramFlowState.advance('telegram', chatId, 'awaiting_price', data);
    return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_price', { userId, data }));
  }
  if (data.skipConfirm) return finishMintExecution(chatId, messageId, userId, data);
  telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
  return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_confirm', { userId, data }));
}

// Shared by both flows' awaiting_price step (typed amount and the accept-OpenSea-price button):
// mint_guided goes on to confirm (or straight to execution in degen/skipConfirm mode), while
// task_guided still needs a name before it can reach its own confirm screen.
async function advanceFromPriceResolved(chatId, messageId, userId, flow, priceETH) {
  const data = { ...flow.data, priceETH, priceUnknown: true };
  if (flow.flow === 'task_guided') {
    telegramFlowState.advance('telegram', chatId, 'awaiting_name', data);
    return tgUpdate(chatId, messageId, renderFlowStep('task_guided', 'awaiting_name', { userId, data }));
  }
  if (data.skipConfirm) return finishMintExecution(chatId, messageId, userId, data);
  telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
  return tgUpdate(chatId, messageId, renderFlowStep('mint_guided', 'awaiting_confirm', { userId, data }));
}

async function finishMintExecution(chatId, messageId, userId, flowData) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  try {
    commandRateLimiter.check('telegram', userId, flowData.multi ? 'batch-mint' : 'mint');
    if (flowData.multi) {
      const results = await botCommands.batchMint(userId, { walletLabels: flowData.selectedWallets,
        contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: flowData.quantity || 1, priceETH: flowData.priceETH });
      telegramFlowState.clear('telegram', chatId);
      return tgUpdate(chatId, messageId, { text: `✅ Batch complete: ${results.length} wallet transaction(s).`, replyMarkup: backToMenu, parseMode: 'HTML' });
    }
    const result = await botCommands.mint(userId, { walletLabel: flowData.selectedWallets[0],
      contractAddress: flowData.contractAddress, chain: flowData.chain, quantity: flowData.quantity || 1, priceETH: flowData.priceETH });
    telegramFlowState.clear('telegram', chatId);
    return tgUpdate(chatId, messageId, { text: `✅ Mint ${result.state}: <code>${result.txHash || result.intentId}</code>`, replyMarkup: backToMenu, parseMode: 'HTML' });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return tgUpdate(chatId, messageId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu, parseMode: 'HTML' });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: escapeTelegramHtml(validationReply(error)), replyMarkup: backToMenu, parseMode: 'HTML' });
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${escapeTelegramHtml(error.message)}`, replyMarkup: backToMenu, parseMode: 'HTML' });
    throw error;
  }
}

// Entry point for /send and the "Send" menu button. Single-wallet users (the common case, since
// /start already auto-creates one) skip straight to the amount prompt -- same TG-05 auto-select
// idiom startMintFlow already uses for wallet selection.
// Fetches the wallet's balance and a conservative gas buffer (standard 21000-gas transfer at the
// chain's current fast fee, +30% headroom) up front so the amount step can offer Max/75%/50%/25%
// quick buttons without renderFlowStep itself needing to be async. A failed lookup just omits the
// quick buttons -- typed amounts still work, and the real balance/gas ceiling checks happen later
// in advanceToSendConfirm's transactionEngine.preview() regardless of how the amount was chosen.
async function sendAmountContext(userId, walletLabel, chain) {
  try {
    const [{ balances }, fees] = await Promise.all([botCommands.walletBalance(userId, walletLabel), botCommands.gas(chain).catch(() => null)]);
    const chainBalance = balances.find(b => b.chain === chain);
    if (!chainBalance?.balance) return {};
    const balanceWei = ethers.parseEther(chainBalance.balance);
    const feeGwei = fees?.maxFeePerGasGwei ?? fees?.gasPriceGwei;
    const gasBufferWei = feeGwei ? (ethers.parseUnits(String(feeGwei), 'gwei') * 21_000n * 13n) / 10n : 0n;
    return { balanceWei: balanceWei.toString(), gasBufferWei: gasBufferWei.toString() };
  } catch { return {}; }
}

async function startSendFlow({ chatId, messageId, userId }) {
  const wallets = botCommands.wallets(userId);
  if (!wallets.length) {
    return tgUpdate(chatId, messageId, { text: 'No wallets yet. Create one first from the Wallets menu.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  if (wallets.length === 1) {
    const data = { walletLabel: wallets[0].label, chain: wallets[0].chain, ...await sendAmountContext(userId, wallets[0].label, wallets[0].chain) };
    telegramFlowState.start('telegram', chatId, 'send_guided', 'awaiting_amount', data);
    return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_amount', { userId, data }));
  }
  telegramFlowState.start('telegram', chatId, 'send_guided', 'awaiting_wallet', {});
  return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_wallet', { userId }));
}

// Shared by both the typed-amount text handler and the Max/75%/50%/25% quick buttons so the
// awaiting_destination transition can't drift between the two entry points.
async function advanceFromSendAmount(chatId, messageId, userId, flow, amountETH) {
  const data = { ...flow.data, amountETH };
  telegramFlowState.advance('telegram', chatId, 'awaiting_destination', data);
  return tgUpdate(chatId, messageId, renderFlowStep('send_guided', 'awaiting_destination', { userId, data }));
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
    return tgUpdate(chatId, messageId, { text: 'That wallet no longer exists.', replyMarkup: backToMenu, parseMode: 'HTML' });
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
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${escapeTelegramHtml(error.message)}`, replyMarkup: backToMenu, parseMode: 'HTML' });
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
    return tgUpdate(chatId, messageId, { text: `✅ Send ${result.state}: <code>${result.txHash || result.intentId}</code>`, replyMarkup: backToMenu, parseMode: 'HTML' });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return tgUpdate(chatId, messageId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu, parseMode: 'HTML' });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: escapeTelegramHtml(validationReply(error)), replyMarkup: backToMenu, parseMode: 'HTML' });
    if (error instanceof TransactionSafetyError) return tgUpdate(chatId, messageId, { text: `❌ ${escapeTelegramHtml(error.message)}`, replyMarkup: backToMenu, parseMode: 'HTML' });
    throw error;
  }
}

// Entry point for /exportkey and the Wallets menu's "Export key" button. Every step here is
// button-only (no free-text capture needed) up to the explicit warning tap, unlike mint/send.
async function startExportKeyFlow({ chatId, messageId, userId }) {
  const wallets = botCommands.wallets(userId);
  if (!wallets.length) {
    return tgUpdate(chatId, messageId, { text: 'No wallets yet.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup, parseMode: 'HTML' });
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
    await tgUpdate(chatId, messageId, { text: `✅ Key for <b>${escapeTelegramHtml(exported.label)}</b> sent below. It self-deletes in ${EXPORT_KEY_TTL_MS / 1000}s -- deletion is a courtesy, not a control.`, replyMarkup: backToMenu, parseMode: 'HTML' });
    await tgSendSelfDestruct(chatId, `🔑 <b>${exported.label}</b>\n<code>${exported.privateKey}</code>`, { parse_mode: 'HTML' });
    await audit({ userId, platform: 'telegram', platformUserId, contextId: String(chatId), command: 'exportkey', outcome: 'success', reason: 'key export delivered' });
  } catch (error) {
    if (error instanceof RateLimitError) {
      await audit({ userId, platform: 'telegram', platformUserId, contextId: String(chatId), command: 'exportkey', outcome: 'rate_limited', reason: 'export key rate limit exceeded' });
      return tgUpdate(chatId, messageId, { text: `Too many export attempts. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu, parseMode: 'HTML' });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: escapeTelegramHtml(validationReply(error)), replyMarkup: backToMenu, parseMode: 'HTML' });
    throw error;
  }
}

// Entry point for /schedule and the Tasks menu's "Schedule mint" button. Shares the same contract
// detection and details screen as startMintFlow (botCommands.detectMintContract) -- what a
// contract *is* doesn't depend on whether you're minting it now or scheduling it for later. A
// SeaDrop drop's own future opening time is carried into flow data as a pre-filled mintTime, same
// as createTask's own auto-detection, so the confirm screen can skip asking for it entirely.
async function startTaskScheduleFlow({ chatId, messageId, userId, contractAddressInput }) {
  const send = payload => tgUpdate(chatId, messageId, payload);
  if (!contractAddressInput) {
    telegramFlowState.start('telegram', chatId, 'task_guided', 'awaiting_contract', {});
    return send(renderFlowStep('task_guided', 'awaiting_contract'));
  }
  if (!ethers.isAddress(contractAddressInput)) {
    return send({ text: 'That does not look like a valid contract address. Try again with /schedule <contract>.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
  }
  let detected;
  try {
    detected = await botCommands.detectMintContract(userId, { contractAddress: contractAddressInput, quantity: 1 });
  } catch (error) {
    if (error instanceof ValidationError) {
      return send({ text: 'Could not find this contract on any supported chain. Double-check the address.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup });
    }
    throw error;
  }
  const futureStartTime = detected.startTime && detected.startTime * 1000 > Date.now() ? detected.startTime : null;
  const data = {
    contractAddress: contractAddressInput, chain: detected.chain, isSeaDrop: detected.isSeaDrop,
    priceETH: detected.priceKnown ? Number(ethers.formatEther(BigInt(detected.valueWei))) : undefined,
    priceUnknown: !detected.priceKnown,
    maxSupply: detected.maxSupply, maxPerWallet: detected.maxPerWallet,
    startTime: detected.startTime, endTime: detected.endTime, collection: detected.collection,
    soldOut: detected.soldOut, displayPrice: detected.displayPrice,
    mintTime: futureStartTime ? new Date(futureStartTime * 1000).toISOString() : null,
  };
  telegramFlowState.start('telegram', chatId, 'task_guided', 'awaiting_details', data);
  return send(renderFlowStep('task_guided', 'awaiting_details', { userId, data }));
}

// Scheduling is always single-wallet (createTask has no batch concept), so this always shows a
// picker rather than the mint flow's multi/single branching -- except the auto-select-with-one-
// wallet shortcut, which still applies.
async function advanceFromTaskDetails(chatId, messageId, userId, flow) {
  const wallets = botCommands.wallets(userId);
  if (wallets.length === 1) {
    return advanceFromTaskWallet(chatId, messageId, userId, flow, wallets[0].label);
  }
  telegramFlowState.advance('telegram', chatId, 'awaiting_wallet', flow.data);
  return tgUpdate(chatId, messageId, renderFlowStep('task_guided', 'awaiting_wallet', { userId, data: flow.data }));
}

// After the wallet is picked: a price createTask can't resolve server-side either (Section G) is
// asked for here rather than surfacing as a late validation error at the very end of the flow.
// Otherwise, always ask for a name (there's no way to auto-detect that), then skip straight to
// confirm if mintTime was already auto-filled from the contract's own opening time, or ask for it
// by hand when it wasn't.
async function advanceFromTaskWallet(chatId, messageId, userId, flow, walletLabel) {
  const data = { ...flow.data, walletLabel };
  if (data.priceUnknown && data.priceETH === undefined) {
    telegramFlowState.advance('telegram', chatId, 'awaiting_price', data);
    return tgUpdate(chatId, messageId, renderFlowStep('task_guided', 'awaiting_price', { userId, data }));
  }
  telegramFlowState.advance('telegram', chatId, 'awaiting_name', data);
  return tgUpdate(chatId, messageId, renderFlowStep('task_guided', 'awaiting_name', { userId, data }));
}

async function finishTaskSchedule(chatId, messageId, userId, flowData) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  try {
    commandRateLimiter.check('telegram', userId, 'task');
    const task = await botCommands.createTask(userId, {
      name: flowData.name, walletLabel: flowData.walletLabel, contractAddress: flowData.contractAddress,
      chain: flowData.chain, quantity: 1, priceETH: flowData.priceETH, mintTime: flowData.mintTime,
    });
    telegramFlowState.clear('telegram', chatId);
    return tgUpdate(chatId, messageId, { text: `✅ Scheduled <b>${escapeTelegramHtml(task.name)}</b> for ${new Date(task.mintTime).toISOString()} UTC.`, replyMarkup: backToMenu, parseMode: 'HTML' });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return tgUpdate(chatId, messageId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds.`, replyMarkup: backToMenu, parseMode: 'HTML' });
    }
    telegramFlowState.clear('telegram', chatId);
    if (error instanceof ValidationError) return tgUpdate(chatId, messageId, { text: escapeTelegramHtml(validationReply(error)), replyMarkup: backToMenu, parseMode: 'HTML' });
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
// Ordering rules live in src/telegram/panelState.js (pure, unit-tested); this file owns only the
// Telegram calls that act on its decisions.
const telegramPanels = createPanelStore();

async function tgEditRaw(chatId, messageId, { text, replyMarkup, parseMode }) {
  if (!bot || !chatId || !messageId) return null;
  try {
    return await bot.editMessageText(String(text), { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup, parse_mode: parseMode });
  } catch {
    return null;
  }
}

// Editing in place is only correct while the panel is still the newest message in the chat. Once
// the user has sent anything below it -- a slash command, a pasted contract address -- an edit
// would update a bubble that now sits ABOVE their message, so the conversation reads out of order
// (the panel appears to answer before the question). In that case the panel *moves* instead: a
// fresh one is sent at the bottom and the stale one removed, so there is still exactly one live
// panel and it is always below whatever the user just typed. The delete is deliberately attempted
// only after the replacement has been sent, so a failed send can never leave the chat with no
// panel at all.
async function tgRender(chatId, payload) {
  const { anchor } = telegramPanels.read(chatId);
  const stale = telegramPanels.shouldMove(chatId);
  if (anchor && !stale) {
    const edited = await tgEditRaw(chatId, anchor, payload);
    if (edited) return edited;
  }
  const sent = await tgMenu(chatId, payload);
  if (sent?.message_id) {
    if (stale && bot) bot.deleteMessage(chatId, anchor).catch(() => {});
    telegramPanels.noteAnchor(chatId, sent.message_id);
  }
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
// Awaited by its callers (rather than fire-and-forget) so the panel bookkeeping below settles
// before the next tgRender decides whether to edit in place or move.
async function tgDeleteUserMessage(msg) {
  if (!bot || !msg?.chat?.id || !msg?.message_id) return;
  try {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
    // The message is gone, so it no longer sits below the live panel. Forgetting it keeps guided
    // flows editing in place -- they always consume and delete the user's reply -- instead of
    // pointlessly moving the panel to get below a message nobody can see any more.
    telegramPanels.noteDeleted(msg.chat.id, msg.message_id);
  } catch { /* older than 48h, or a chat where the bot lacks delete rights -- expected, ignore */ }
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
  if (!flow) {
    // A bare contract address with no active flow and no leading slash is treated as "show me
    // this contract" -- the same detection /mint's inline-address form already runs, just reached
    // without typing the command. Anything that isn't address-shaped is ignored rather than
    // guessed at, same as before this existed.
    const trimmed = msg.text.trim();
    if (ethers.isAddress(trimmed)) await startMintFlow({ chatId, messageId: null, userId, multi: false, contractAddressInput: trimmed });
    return;
  }
  if (flow.pendingCancel) { await tgDeleteUserMessage(msg); tgRender(chatId, telegramMenus.confirmCancelPrompt(FLOW_LABELS[flow.flow] || flow.flow)); return; }
  const isTextStep = (flow.flow === 'wallet_create' && flow.step === 'awaiting_label')
    || (flow.flow === 'wallet_import' && (flow.step === 'awaiting_label' || flow.step === 'awaiting_key'))
    || (flow.flow === 'mint_guided' && ['awaiting_contract', 'awaiting_quantity', 'awaiting_price'].includes(flow.step))
    || (flow.flow === 'send_guided' && (flow.step === 'awaiting_amount' || flow.step === 'awaiting_destination'))
    || (flow.flow === 'task_guided' && ['awaiting_contract', 'awaiting_price', 'awaiting_name', 'awaiting_time'].includes(flow.step));
  if (!isTextStep) { await tgDeleteUserMessage(msg); tgRender(chatId, { text: 'Please use the buttons above, or tap Cancel.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' }); return; }

  // Consumed as flow input from here on -- clear it immediately rather than after a successful
  // outcome, so a private key or any other sensitive reply never lingers in chat history even if
  // validation later rejects it.
  await tgDeleteUserMessage(msg);
  const value = msg.text.trim();
  if (flow.step === 'awaiting_label') {
    if (!value || value.length > 64) { tgRender(chatId, { text: 'Label must be 1-64 characters. Try again.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' }); return; }
    telegramFlowState.advance('telegram', chatId, 'awaiting_chain', { label: value });
    tgRender(chatId, renderFlowStep(flow.flow, 'awaiting_chain'));
    return;
  }
  if (flow.step === 'awaiting_key') {
    try {
      commandRateLimiter.check('telegram', userId, 'importwallet');
      const wallet = await botCommands.importWallet(userId, { label: flow.data.label, chain: flow.data.chain, privateKey: value });
      telegramFlowState.clear('telegram', chatId);
      tgRender(chatId, { text: `✅ Wallet <b>${escapeTelegramHtml(wallet.label)}</b> imported at <code>${wallet.address}</code>.\n\n⚠️ Not recommended going forward: prefer /createwallet for new wallets.`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    } catch (error) {
      if (error instanceof ValidationError) {
        const retryStep = retryStepForField(error);
        if (retryStep) {
          telegramFlowState.advance('telegram', chatId, retryStep, {});
          const prompt = renderFlowStep(flow.flow, retryStep);
          tgRender(chatId, { text: `${escapeTelegramHtml(validationReply(error))}\n\n${prompt.text}`, replyMarkup: prompt.replyMarkup, parseMode: 'HTML' });
          return;
        }
        telegramFlowState.clear('telegram', chatId);
        tgRender(chatId, { text: escapeTelegramHtml(validationReply(error)), replyMarkup: telegramMenus.mainMenu({}).replyMarkup, parseMode: 'HTML' });
        return;
      }
      if (error instanceof RateLimitError) {
        tgRender(chatId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
        return;
      }
      telegramFlowState.clear('telegram', chatId);
      log(`Telegram guided wallet import failed: ${safeError(error)}`);
      tgRender(chatId, { text: 'Import failed safely. Please try again from the Wallets menu.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup, parseMode: 'HTML' });
    }
    return;
  }
  if (flow.flow === 'mint_guided' && flow.step === 'awaiting_contract') {
    await startMintFlow({ chatId, messageId: null, userId, multi: flow.data.multi, contractAddressInput: value });
    return;
  }
  if (flow.flow === 'mint_guided' && flow.step === 'awaiting_quantity') {
    const quantity = Math.floor(Number(value));
    const max = Number(flow.data.maxPerWallet) || 100;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
      tgRender(chatId, { text: `Send a whole number from 1 to ${max}.`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    await advanceFromQuantity(chatId, null, userId, flow, quantity);
    return;
  }
  if ((flow.flow === 'mint_guided' || flow.flow === 'task_guided') && flow.step === 'awaiting_price') {
    const priceETH = Number(value);
    if (!Number.isFinite(priceETH) || priceETH < 0) {
      tgRender(chatId, { text: 'Send a valid non-negative number.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    await advanceFromPriceResolved(chatId, null, userId, flow, priceETH);
    return;
  }
  if (flow.flow === 'send_guided' && flow.step === 'awaiting_amount') {
    const amountETH = Number(value);
    if (!Number.isFinite(amountETH) || amountETH <= 0) {
      tgRender(chatId, { text: 'Send a positive number.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    await advanceFromSendAmount(chatId, null, userId, flow, amountETH);
    return;
  }
  if (flow.flow === 'send_guided' && flow.step === 'awaiting_destination') {
    if (!ethers.isAddress(value)) {
      tgRender(chatId, { text: 'That does not look like a valid address. Try again.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    await advanceToSendConfirm(chatId, null, userId, flow, value);
    return;
  }
  if (flow.flow === 'task_guided' && flow.step === 'awaiting_contract') {
    await startTaskScheduleFlow({ chatId, messageId: null, userId, contractAddressInput: value });
    return;
  }
  if (flow.flow === 'task_guided' && flow.step === 'awaiting_name') {
    if (!value || value.length > 100) {
      tgRender(chatId, { text: 'Name must be 1-100 characters. Try again.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    const data = { ...flow.data, name: value };
    const nextStep = data.mintTime ? 'awaiting_confirm' : 'awaiting_time';
    telegramFlowState.advance('telegram', chatId, nextStep, data);
    tgRender(chatId, renderFlowStep('task_guided', nextStep, { userId, data }));
    return;
  }
  if (flow.flow === 'task_guided' && flow.step === 'awaiting_time') {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      tgRender(chatId, { text: 'Include an explicit UTC offset or Z suffix, e.g. <code>2026-08-20T18:00:00Z</code>. Try again.', replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
      return;
    }
    const data = { ...flow.data, mintTime: value };
    telegramFlowState.advance('telegram', chatId, 'awaiting_confirm', data);
    tgRender(chatId, renderFlowStep('task_guided', 'awaiting_confirm', { userId, data }));
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
      if (messageId) telegramPanels.noteAnchor(chatId, messageId);

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
          await tgEditMenu(chatId, messageId, { text: 'That confirmation expired or was already handled. Run the command again if needed.', replyMarkup: backToMenu, parseMode: 'HTML' });
          return;
        }
        if (data === 'cancel:pending') {
          await tgEditMenu(chatId, messageId, { text: 'Cancelled.', replyMarkup: backToMenu, parseMode: 'HTML' });
          return;
        }
        const resultText = await pending.run();
        await tgEditMenu(chatId, messageId, { text: resultText, replyMarkup: backToMenu, parseMode: 'HTML' });
        return;
      }

      await handler(query, userId, { chatId, messageId });
    } catch (error) {
      if (error instanceof ValidationError) { tgRender(chatId, { text: escapeTelegramHtml(validationReply(error)), parseMode: 'HTML' }); return; }
      if (error instanceof AccountBlockedError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'account_blocked',reason:error.message});
        tgRender(chatId, { text: `⛔ Your account is ${escapeTelegramHtml(error.status)}${error.reason ? `: ${escapeTelegramHtml(error.reason)}` : ''}. Contact the project owner if you believe this is a mistake.`, parseMode: 'HTML' });
        return;
      }
      if (error instanceof AuthorizationError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'unauthorized',reason:error.message});
        tgRender(chatId, { text: '❌ Owner access required.', parseMode: 'HTML' });
        return;
      }
      if (error instanceof RateLimitError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(query.data),outcome:'rate_limited',reason:error.message});
        tgRender(chatId, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`, parseMode: 'HTML' });
        return;
      }
      if (error instanceof BotContextError) {
        await audit({platform:'telegram',platformUserId:query.from?.id,contextId:query.message?.chat?.id,
          command:commandName(query.data),outcome:'invalid_context',reason:error.message});
        return;
      }
      if (error instanceof ProofResolutionError) { tgRender(chatId, { text: `❌ ${escapeTelegramHtml(error.message)}`, parseMode: 'HTML' }); return; }
      log(`Telegram callback failed: ${safeError(error)}`);
      tgRender(chatId, { text: 'Action failed safely. Please try again.', parseMode: 'HTML' });
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
        tgRender(msg.chat.id, { text: escapeTelegramHtml(validationReply(error)), parseMode: 'HTML' });
        return;
      }
      if (error instanceof AccountBlockedError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'account_blocked',reason:error.message});
        tgRender(msg.chat.id, { text: `⛔ Your account is ${escapeTelegramHtml(error.status)}${error.reason ? `: ${escapeTelegramHtml(error.reason)}` : ''}. Contact the project owner if you believe this is a mistake.`, parseMode: 'HTML' });
        return;
      }
      if (error instanceof AuthorizationError) {
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'unauthorized',reason:error.message});
        tgRender(msg.chat.id, { text: '❌ Owner access required.', parseMode: 'HTML' });
        return;
      }
      if(error instanceof RateLimitError){
        await audit({userId,platform:'telegram',platformUserId:context?.platformUserId,
          contextId:context?.contextId,command:commandName(msg.text||msg.caption),outcome:'rate_limited',reason:error.message});
        tgRender(msg.chat.id, { text: `Too many sensitive commands. Retry in ${Math.ceil(error.retryAfterMs/1000)} seconds.`, parseMode: 'HTML' });return;
      }
      if(error instanceof BotContextError){
        await audit({platform:'telegram',platformUserId:msg.from?.id,contextId:msg.chat?.id,
          command:commandName(msg.text||msg.caption),outcome:'invalid_context',reason:error.message});return;
      }
      if (error instanceof ProofResolutionError) {
        tgRender(msg.chat.id, { text: `❌ ${escapeTelegramHtml(error.message)}`, parseMode: 'HTML' });
        return;
      }
      if (error instanceof TransactionSafetyError) {
        tgRender(msg.chat.id, { text: `❌ ${escapeTelegramHtml(error.message)}`, parseMode: 'HTML' });
        return;
      }
      log(`Telegram command failed: ${safeError(error)}`);
      tgRender(msg.chat.id, { text: 'Command failed safely. Please try again.', parseMode: 'HTML' });
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
    { command: 'deposit', description: 'Get an address to fund your wallet' },
    { command: 'createwallet', description: 'Generate and encrypt a new wallet' },
    { command: 'importwallet', description: 'Import an existing wallet (not recommended)' },
    { command: 'removewallet', description: 'Remove a wallet' },
    { command: 'exportkey', description: 'Export a wallet\'s private key' },
    { command: 'mintnow', description: 'Mint immediately' },
    { command: 'mintcall', description: 'Mint via raw validated call JSON' },
    { command: 'mintpresets', description: 'List saved mint presets' },
    { command: 'schedule', description: 'Schedule a future mint' },
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
    // Every inbound message -- slash command or free text -- lands below the live panel, which is
    // what makes an in-place edit read out of order. Recording it here (before any handler runs)
    // is what lets tgRender decide to move the panel instead. Guided flows that delete the user's
    // reply undo this again inside tgDeleteUserMessage.
    if (msg.chat?.id && msg.message_id) telegramPanels.noteIncoming(msg.chat.id, msg.message_id);
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
    if (data === 'menu:tasks') return tgEditMenu(chatId, messageId, telegramMenus.tasksMenu());
    if (data === 'menu:schedule') return startTaskScheduleFlow({ chatId, messageId, userId, contractAddressInput: null });
    if (data === 'menu:snipers') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Snipers', 'Use /snipers to list, /updatesniper &lt;id&gt; &lt;JSON&gt; to edit.'));
    if (data === 'menu:watch') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Watch rules', 'Use /watch add|edit|disable|remove|list.'));
    if (data === 'menu:activity') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Activity', 'Use /activity to see recent mint activity.'));
    if (data === 'menu:gas' || data.startsWith('gas:chain:')) {
      const chain = data.startsWith('gas:chain:') ? data.slice('gas:chain:'.length) : 'ethereum';
      let fees = null;
      try { fees = await botCommands.gas(chain); } catch { /* gasMenu shows "unavailable" for null fees */ }
      return tgEditMenu(chatId, messageId, telegramMenus.gasMenu(chain, fees, CONFIG.supportedChains, CHAINS));
    }
    if (data === 'menu:mode') {
      const [presets, current, advancedModesAllowed] = await Promise.all([
        botCommands.modePresets(), botCommands.currentMode(userId), botCommands.advancedModesAllowed(userId),
      ]);
      return tgEditMenu(chatId, messageId, telegramMenus.modeMenu(current?.key, presets, advancedModesAllowed));
    }
    if (data.startsWith('mode:pick:')) {
      const key = data.slice('mode:pick:'.length);
      const meta = telegramMenus.MODE_META[key];
      if (!meta) return tgEditMenu(chatId, messageId, { text: 'Unknown preset.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup, parseMode: 'HTML' });
      setPendingConfirmation(chatId, async () => {
        await botCommands.selectMode(userId, key);
        return `✅ Transaction mode set to <b>${escapeTelegramHtml(meta.label)}</b>.`;
      });
      return tgEditMenu(chatId, messageId, { text: `Switch to <b>${escapeTelegramHtml(meta.label)}</b> (${escapeTelegramHtml(meta.hint)})? This changes behavior for every mint on every platform until you switch again.`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
    }
    if (data === 'menu:admin') return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Admin', 'Use /admin &lt;action&gt; CONFIRM. Owner-only.'));

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
          return tgEditMenu(chatId, messageId, { text: `✅ Wallet <b>${escapeTelegramHtml(wallet.label)}</b> generated securely.\nAddress: <code>${wallet.address}</code>\nChain: ${wallet.chain}\n\nFund this address to use it. The private key was encrypted at creation and never leaves the server.`,
            replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
        } catch (error) {
          if (error instanceof ValidationError) {
            const retryStep = retryStepForField(error) || 'awaiting_label';
            telegramFlowState.advance('telegram', chatId, retryStep, {});
            const prompt = renderFlowStep('wallet_create', retryStep);
            return tgEditMenu(chatId, messageId, { text: `${escapeTelegramHtml(validationReply(error))}\n\n${prompt.text}`, replyMarkup: prompt.replyMarkup, parseMode: 'HTML' });
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

    if (data === 'flow:mintdetailscontinue') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow) return;
      if (flow.flow === 'mint_guided') return advanceFromDetails(chatId, messageId, userId, flow);
      if (flow.flow === 'task_guided') return advanceFromTaskDetails(chatId, messageId, userId, flow);
      return;
    }
    if (data === 'flow:mintqty:x') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_quantity') return;
      const max = Number(flow.data.maxPerWallet) || 100;
      return tgEditMenu(chatId, messageId, { text: `Send a whole number from 1 to ${max}.`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
    }
    if (data.startsWith('flow:mintqty:')) {
      const quantity = Number(data.slice('flow:mintqty:'.length));
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'mint_guided' || flow.step !== 'awaiting_quantity' || !Number.isInteger(quantity) || quantity < 1) return;
      return advanceFromQuantity(chatId, messageId, userId, flow, quantity);
    }
    if (data === 'flow:priceaccept') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.step !== 'awaiting_price' || !flow.data.displayPrice) return;
      if (flow.flow !== 'mint_guided' && flow.flow !== 'task_guided') return;
      return advanceFromPriceResolved(chatId, messageId, userId, flow, flow.data.displayPrice.eth);
    }
    if (data === 'flow:pricemanual') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.step !== 'awaiting_price') return;
      if (flow.flow !== 'mint_guided' && flow.flow !== 'task_guided') return;
      const sym = CHAINS[flow.data.chain]?.sym || 'native currency';
      return tgEditMenu(chatId, messageId, { text: `Send the price per item in ${sym} (send 0 if it is free).`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
    }
    if (data.startsWith('flow:taskwalletpick:')) {
      const label = data.slice('flow:taskwalletpick:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'task_guided') return;
      return advanceFromTaskWallet(chatId, messageId, userId, flow, label);
    }
    if (data === 'flow:taskconfirm') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'task_guided') return;
      return finishTaskSchedule(chatId, messageId, userId, flow.data);
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
      const flowData = { walletLabel: owned.label, chain: owned.chain, ...await sendAmountContext(userId, owned.label, owned.chain) };
      telegramFlowState.advance('telegram', chatId, 'awaiting_amount', flowData);
      return tgEditMenu(chatId, messageId, renderFlowStep('send_guided', 'awaiting_amount', { userId, data: flowData }));
    }
    if (data === 'flow:sendamount:x') {
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'send_guided' || flow.step !== 'awaiting_amount') return;
      const sym = CHAINS[flow.data.chain]?.sym || 'native currency';
      return tgEditMenu(chatId, messageId, { text: `Send the exact ${sym} amount to send.`, replyMarkup: cancelOnlyKeyboard(), parseMode: 'HTML' });
    }
    if (data.startsWith('flow:sendamount:')) {
      const key = data.slice('flow:sendamount:'.length);
      const flow = telegramFlowState.get('telegram', chatId);
      if (!flow || flow.flow !== 'send_guided' || flow.step !== 'awaiting_amount' || !flow.data.balanceWei) return;
      const fraction = { max: 100, '75': 75, '50': 50, '25': 25 }[key];
      if (!fraction) return;
      // Max reserves the gas buffer computed in sendAmountContext; the percentage tiers apply to
      // the raw balance since they're explicitly a fraction of holdings, not "spend everything" --
      // the same insufficient-balance safety check in advanceToSendConfirm still applies either way.
      const spendableWei = fraction === 100 ? BigInt(flow.data.balanceWei) - BigInt(flow.data.gasBufferWei || 0)
        : (BigInt(flow.data.balanceWei) * BigInt(fraction)) / 100n;
      if (spendableWei <= 0n) {
        return tgEditMenu(chatId, messageId, { text: 'Balance is too low to cover network fees for this send.', replyMarkup: telegramMenus.mainMenu({}).replyMarkup, parseMode: 'HTML' });
      }
      return advanceFromSendAmount(chatId, messageId, userId, flow, Number(ethers.formatEther(spendableWei)));
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
      return tgEditMenu(chatId, messageId, { text: `<b>${escapeTelegramHtml(result.label)}</b>\n<code>${result.address}</code>\n${lines}`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    }

    // Only reached from /address's own picker (no menu entry point -- the point of /address is to
    // skip menu traversal entirely; the wallets menu's "List wallets" already shows every address).
    if (data.startsWith('wallet:address:pick:')) {
      const label = data.slice('wallet:address:pick:'.length);
      const owned = botCommands.wallets(userId).find(w => w.label === label);
      if (!owned) return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Wallets', 'That wallet no longer exists.'));
      return tgEditMenu(chatId, messageId, { text: `<b>${escapeTelegramHtml(owned.label)}</b>\n<code>${owned.address}</code>`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
    }
    if (data.startsWith('wallet:deposit:pick:')) {
      const label = data.slice('wallet:deposit:pick:'.length);
      const owned = botCommands.wallets(userId).find(w => w.label === label);
      if (!owned) return tgEditMenu(chatId, messageId, telegramMenus.placeholderMenu('Wallets', 'That wallet no longer exists.'));
      return tgEditMenu(chatId, messageId, { text: `Send funds to <b>${escapeTelegramHtml(owned.label)}</b>:\n<code>${owned.address}</code>\n\nEVM -- works on any supported chain.`,
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
      return tgEditMenu(chatId, messageId, { text: `🗑️ Wallet <b>${escapeTelegramHtml(label)}</b> removed.`,
        replyMarkup: telegramMenus.keyboard([[telegramMenus.button('⬅️ Back to wallets', 'menu:wallets')]]), parseMode: 'HTML' });
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
      return `<b>${escapeTelegramHtml(w.label)}</b>\n<code>${w.address}</code>\nEVM\n${lines}`;
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
    if (!isStart) return tgRender(msg.chat.id, { text: menu.text, replyMarkup: menu.replyMarkup, parseMode: menu.parseMode });
    const summary = await walletSummaryHtml(userId);
    tgRender(msg.chat.id, { text: `${WELCOME_TEXT}\n\n${summary}\n\n${menu.text}`, replyMarkup: menu.replyMarkup, parseMode: 'HTML' });
  }));

  bot.onText(/^\/address(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return tgRender(msg.chat.id, { text: 'No wallets yet. /wallets to create one.', parseMode: 'HTML' });
    if (wallets.length === 1) {
      return tgRender(msg.chat.id, { text: `<b>${escapeTelegramHtml(wallets[0].label)}</b>\n<code>${wallets[0].address}</code>`, parseMode: 'HTML' });
    }
    tgRender(msg.chat.id, telegramMenus.walletPicker(wallets, { prefix: 'wallet:address:pick', emptyHint: 'No wallets yet.' }));
  }));

  // Same lookup as /address, deposit-framed: "send funds here" rather than a bare address dump.
  bot.onText(/^\/deposit(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return tgRender(msg.chat.id, { text: 'No wallets yet. /wallets to create one.', parseMode: 'HTML' });
    if (wallets.length === 1) {
      return tgRender(msg.chat.id, { text: `Send funds to <b>${escapeTelegramHtml(wallets[0].label)}</b>:\n<code>${wallets[0].address}</code>\n\nEVM -- works on any supported chain.`, parseMode: 'HTML' });
    }
    tgRender(msg.chat.id, telegramMenus.walletPicker(wallets, { prefix: 'wallet:deposit:pick', emptyHint: 'No wallets yet.' }));
  }));

  bot.onText(/^\/mint(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match, userId) => {
    await startMintFlow({ chatId: msg.chat.id, messageId: null, userId, multi: false, contractAddressInput: match[1] || null });
  }));

  // /mintnow is /mint with oneShot:true: once the contract, a single wallet, and the price are all
  // resolvable AND the caller has opted into a bypass-verification transaction mode (Section C), it
  // reaches execution with zero taps -- "mint immediately without asking questions." Anything the
  // system genuinely can't resolve (multiple wallets, an unreadable price) is still asked for, and
  // without bypass mode selected it behaves exactly like /mint, never a silent no-op.
  bot.onText(/^\/mintnow(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match, userId) => {
    await startMintFlow({ chatId: msg.chat.id, messageId: null, userId, multi: false, contractAddressInput: match[1] || null, oneShot: true });
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

  bot.onText(/^\/schedule(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match, userId) => {
    await startTaskScheduleFlow({ chatId: msg.chat.id, messageId: null, userId, contractAddressInput: match[1] || null });
  }));

  bot.onText(/^\/link(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const link = await identity.createLinkCode(userId);
    tgRender(msg.chat.id, { text: `🔗 <b>Account link code:</b> <code>${link.code}</code>\n\nTap the code to copy it. Expires in 5 minutes and can be used once.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/mode(?:@\w+)?\s+(\S+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const selected = await botCommands.selectMode(userId, match[1]);
    tgRender(msg.chat.id, { text: `✅ Transaction mode set to <b>${escapeTelegramHtml(selected.replaceAll('_', ' '))}</b>.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/admin(?:@\w+)?\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    tgRender(msg.chat.id, { text: escapeTelegramHtml(await botCommands.admin(userId, match[1])), parseMode: 'HTML' });
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
      onPreview: preview => tgRender(msg.chat.id, { text: `<code>${escapeTelegramHtml(formatMintPreview(preview))}</code>`, parseMode: 'HTML' }) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Minted via ${prepared.method.signature}`, wallet.label, intent, CHAINS[payload.chain || wallet.chain]);
    await tgRender(msg.chat.id, { text: `✅ Mint successful.\n${CHAINS[payload.chain || wallet.chain].ex}${intent.txHash}`, parseMode: 'HTML' });
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
    await tgRender(msg.chat.id, { text: `✅ Mint preset <b>${escapeTelegramHtml(saved.name)}</b> saved.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+use\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const payload = commandJson(match[1]);
    if(payload.confirmation!=='CONFIRM')throw new ValidationError({field:'confirmation',message:'must exactly equal CONFIRM'});
    const wallet = findOwnedWallet(DB, userId, payload.walletLabel);
    if (!wallet) throw new ValidationError({ field:'walletLabel', message:'was not found' });
    const prepared = await mintService.preparePreset(userId, payload.name, wallet.address);
    const intent = await executePreparedMint({ wallet, prepared, chain: prepared.chain,
      onPreview: preview => tgRender(msg.chat.id, { text: `<code>${escapeTelegramHtml(formatMintPreview(preview))}</code>`, parseMode: 'HTML' }) });
    const quantity = previewQuantity(prepared.preview);
    wallet.minted = (wallet.minted || 0) + quantity;
    await storage.updateWalletMinted(userId, wallet.label, wallet.minted);
    await logActivity(userId, 'success', `Preset mint via ${prepared.method.signature}`, wallet.label, intent, CHAINS[prepared.chain]);
    await tgRender(msg.chat.id, { text: `✅ Preset mint successful.\n${CHAINS[prepared.chain].ex}${intent.txHash}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/mintpreset(?:@\w+)?\s+delete\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[2]);
    const deleted = await mintService.deletePreset(userId, match[1]);
    await tgRender(msg.chat.id, { text: deleted ? '✅ Mint preset deleted.' : 'Mint preset not found.', parseMode: 'HTML' });
  }));

  bot.onText(/^\/mintpresets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const presets = await mintService.listPresets(userId);
    await tgRender(msg.chat.id, { text: presets.length ? presets.map(preset => `• <b>${escapeTelegramHtml(preset.name)}</b> — <code>${escapeTelegramHtml(preset.methodSignature)}</code>`).join('\n') : 'No mint presets saved.', parseMode: 'HTML' });
  }));

  bot.onText(/^\/snipers(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const snipers = botCommands.snipers(userId);
    if (!snipers.length) return tgRender(msg.chat.id, { text: 'No snipers configured.', parseMode: 'HTML' });
    const list = snipers.map(s =>
      `${s.active?'🟢':'⚪'} <b>${escapeTelegramHtml(s.label)}</b>\nTarget: <code>${s.targetAddress.slice(0,10)}...</code>\nChain: ${CHAINS[s.chain]?.name||s.chain} · Wallet: ${escapeTelegramHtml(s.walletLabel)}\nHits: ${s.hits||0} · Fails: ${s.fails||0}`
    ).join('\n\n');
    tgRender(msg.chat.id, { text: `🎯 <b>Post-confirmation copy snipers (${snipers.length})</b>\n<i>Not mempool front-running: copying begins only after the source transaction confirms.</i>\n\n${list}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/updatesniper(?:@\w+)?\s+([0-9a-f-]+)\s+(.+)\s+(CONFIRM)$/i, withTelegramUser(async (msg, match, userId) => {
    requireTextConfirmation(match[3]);
    const updated = await botCommands.updateSniper(userId, match[1], commandJson(match[2]));
    const sniper = botCommands.snipers(userId).find(item => item.id === updated.id);
    tgRender(msg.chat.id, { text: `✅ Post-confirmation copy sniper <b>${escapeTelegramHtml(sniper.label)}</b> updated. This is not mempool front-running.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/wallets(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const wallets = botCommands.wallets(userId);
    if (!wallets.length) return tgRender(msg.chat.id, { text: 'No wallets yet.', parseMode: 'HTML' });
    const summary = await walletSummaryHtml(userId);
    tgRender(msg.chat.id, { text: `⬡ <b>Wallets (${wallets.length})</b>\n\n${summary}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/createwallet(?:@\w+)?\s+(\S+)\s+(\S+)$/i, withTelegramUser(async (msg, match, userId) => {
    const wallet = await botCommands.createWallet(userId, { label: match[1], chain: match[2] });
    tgRender(msg.chat.id, { text: `✅ Wallet <b>${escapeTelegramHtml(wallet.label)}</b> generated securely.\nPublic address: <code>${wallet.address}</code>\nChain: ${wallet.chain}\n\nFund this public address to use it. The private key was encrypted at creation and is never returned through Telegram.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/importwallet(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)$/i, withTelegramUser(async (msg, match, userId) => {
    const wallet = await botCommands.importWallet(userId, { label: match[1], chain: match[2], privateKey: match[3] });
    tgRender(msg.chat.id, { text: `✅ Wallet <b>${escapeTelegramHtml(wallet.label)}</b> imported at <code>${wallet.address}</code>.\n\n⚠️ <b>Not recommended:</b> the private key passed through Telegram's message transit and may remain in client history or notification previews. Prefer /createwallet; a future HTTPS dashboard will provide a safer import path.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+add\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.createWatchRule(userId, commandJson(match[1]));
    tgRender(msg.chat.id, { text: `✅ Social watch rule <b>${escapeTelegramHtml(rule.name)}</b> created using ${rule.method}.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+edit\s+([0-9a-f-]+)\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.updateWatchRule(userId, match[1], commandJson(match[2]));
    tgRender(msg.chat.id, { text: `✅ Social watch rule <b>${escapeTelegramHtml(rule.name)}</b> updated; ${rule.method} adapter selected.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+disable\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const rule = await botCommands.disableWatchRule(userId, match[1]);
    tgRender(msg.chat.id, { text: `⏸ Social watch rule <b>${escapeTelegramHtml(rule.name)}</b> disabled.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+remove\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const rule = (await botCommands.watchRules(userId)).find(item => item.id === id);
    if (!rule) return tgRender(msg.chat.id, { text: 'Social watch rule not found. Use /watch list.', parseMode: 'HTML' });
    setPendingConfirmation(msg.chat.id, async () => {
      await botCommands.removeWatchRule(userId, id);
      return `✅ Social watch rule <b>${escapeTelegramHtml(rule.name)}</b> removed.`;
    });
    tgRender(msg.chat.id, { text: `Remove social watch rule <b>${escapeTelegramHtml(rule.name)}</b>? This cannot be undone.`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
  }));

  bot.onText(/^\/watch(?:@\w+)?\s+list$/i, withTelegramUser(async (msg, match, userId) => {
    const rules = await botCommands.watchRules(userId);
    tgRender(msg.chat.id, { text: rules.length ? rules.map(rule => `${rule.enabled?'🟢':'⚪'} <b>${escapeTelegramHtml(rule.name)}</b> — ${rule.type} via ${rule.method}\nID: <code>${rule.id}</code>`).join('\n\n') : 'No social watch rules.', parseMode: 'HTML' });
  }));

  bot.onText(/^\/socialusage(?:@\w+)?(?:\s+(today|month))?$/i, withTelegramUser(async (msg, match, userId) => {
    tgRender(msg.chat.id, { text: escapeTelegramHtml(formatUsageSummary(await botCommands.socialUsage(userId, match[1] || 'month'))), parseMode: 'HTML' });
  }));

  bot.onText(/^\/targetpolicy(?:@\w+)?\s+set\s+(.+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[2]);
    const policy=await botCommands.updateTargetPolicy(userId,commandJson(match[1]));
    tgRender(msg.chat.id,{text:`✅ Target policy saved: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+show\s+(sniper|social_rule)\s+([0-9a-f-]+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const policy=await botCommands.targetPolicy(userId,match[1],match[2]);
    tgRender(msg.chat.id,{text:`Target policy: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}, acknowledged ${policy.dontAskAgain?'yes':'no'}.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+reset\s+(sniper|social_rule)\s+([0-9a-f-]+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[3]);
    const policy=await botCommands.resetTargetPolicy(userId,match[1],match[2]);
    tgRender(msg.chat.id,{text:`✅ Target policy reset: blockchain ${policy.blockchainTrigger}, social ${policy.socialTrigger}, verification ${policy.humanVerification}.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+bypass\s+(.+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const result=await botCommands.requestTargetBypass(userId,commandJson(match[1]));
    tgRender(msg.chat.id,{text:result.requiresConfirmation?`${escapeTelegramHtml(result.warning)}\nChallenge: <code>${result.challengeId}</code>\nUse /confirmbypass ${result.challengeId} CONFIRM`:'✅ Verification bypass enabled for this previously acknowledged target.',parseMode:'HTML'});
  }));
  bot.onText(/^\/confirmbypass(?:@\w+)?\s+([0-9a-f-]+)\s+(\S+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const policy=await botCommands.confirmTargetBypass(userId,{challengeId:match[1],confirmation:match[2]});
    tgRender(msg.chat.id,{text:`✅ Verification is now ${policy.humanVerification} for this target.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/targetpolicy(?:@\w+)?\s+preset\s+(.+)\s+(CONFIRM)$/i,withTelegramUser(async(msg,match,userId)=>{
    requireTextConfirmation(match[2]);
    const result=await botCommands.applyTargetPreset(userId,commandJson(match[1]));
    tgRender(msg.chat.id,{text:result.requiresConfirmation?`${escapeTelegramHtml(result.warning)}\nChallenge: <code>${result.challengeId}</code>\nUse /confirmbypass ${result.challengeId} CONFIRM`:`✅ Target preset applied; verification ${result.humanVerification}.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/confirmtrigger(?:@\w+)?\s+([0-9a-f-]+)\s+(\S+)$/i,withTelegramUser(async(msg,match,userId)=>{
    const result=await botCommands.confirmTrigger(userId,match[1],match[2]);
    tgRender(msg.chat.id,{text:result.action==='rejected'?'Trigger rejected.':`✅ Triggered mint ${result.result.state}.`,parseMode:'HTML'});
  }));
  bot.onText(/^\/triggeraudit(?:@\w+)?$/i,withTelegramUser(async(msg,match,userId)=>{
    const rows=await botCommands.triggerAudit(userId);tgRender(msg.chat.id,{text:rows.length?rows.map(row=>`${row.trigger_source} | ${row.target_type}:${row.target_id} | verification ${row.verification_state} | ${row.outcome}`).join('\n'):'No trigger executions audited.',parseMode:'HTML'});
  }));
  bot.onText(/^\/pending(?:@\w+)?$/i,withTelegramUser(async(msg,match,userId)=>{
    const [transactions,confirmations]=await Promise.all([botCommands.pendingTransactions(userId),botCommands.pendingConfirmations(userId)]);
    tgRender(msg.chat.id,{text:`Pending transactions: ${transactions.length}\n${transactions.map(row=>`${row.intentId} | ${row.state} | ${row.chain}`).join('\n')||'None'}\n\nPending confirmations: ${confirmations.length}\n${confirmations.map(row=>`${row.id} | ${row.triggerSource} | expires ${new Date(row.expiresAt).toISOString()}`).join('\n')||'None'}`,parseMode:'HTML'});
  }));
  bot.onText(/^\/transactions(?:@\w+)?(?:\s+(\d+))?$/i,withTelegramUser(async(msg,match,userId)=>{
    const page=await botCommands.transactionsPage(userId,{page:match[1]||1});
    const rows=page.items.map(row=>`${row.intentId} | ${row.state} | ${row.chain}`).join('\n')||'No transactions.';
    tgRender(msg.chat.id,{text:`Transactions (page ${page.page}/${page.totalPages}, ${page.total} total)\n${rows}`,parseMode:'HTML'});
  }));

  bot.onText(/^\/tasks(?:@\w+)?(?:\s+(\d+))?$/, withTelegramUser(async (msg, match, userId) => {
    const page = await botCommands.tasksPage(userId, { page: match[1] || 1 });
    const pending = page.items;
    if (!pending.length) return tgRender(msg.chat.id, { text: 'No scheduled tasks.', parseMode: 'HTML' });
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ <b>${escapeTelegramHtml(t.name)}</b> [${t.status}]\nWallet: ${escapeTelegramHtml(t.walletLabel)}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nDue (UTC): <b>${new Date(t.mintTime).toISOString()}</b>${ms>0?`\nFires in: <b>${fmtCD(ms)}</b>`:''}\nID: <code>${t.id}</code>`;
    }).join('\n\n');
    tgRender(msg.chat.id, { text: `⏱ <b>Tasks (page ${page.page}/${page.totalPages}, ${page.total} total)</b>\n\n${list}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/activity(?:@\w+)?(?:\s+(\d+))?$/, withTelegramUser(async (msg, match, userId) => {
    const page = await botCommands.activityPage(userId, { page: match[1] || 1 });
    const recent = page.items;
    if (!recent.length) return tgRender(msg.chat.id, { text: 'No activity yet.', parseMode: 'HTML' });
    const list = recent.map(a => {
      const ico = a.status==='success'?'✅':'❌';
      const tx  = a.txHash?`\n   <a href="${a.explorer}${a.txHash}">View tx</a>`:'';
      return `${ico} ${escapeTelegramHtml(a.title)} · <b>${escapeTelegramHtml(a.walletLabel)}</b>\n   ${new Date(a.time).toLocaleString()}${tx}`;
    }).join('\n\n');
    tgRender(msg.chat.id, { text: `📋 <b>Activity (page ${page.page}/${page.totalPages}, ${page.total} total)</b>\n\n${list}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/gas(?:@\w+)?(?:\s+(\S+))?$/, withTelegramUser(async (msg, match) => {
    const requested = match[1]?.toLowerCase();
    const chain = requested && CONFIG.supportedChains.includes(requested) ? requested : 'ethereum';
    try {
      const fees = await botCommands.gas(chain);
      tgRender(msg.chat.id, telegramMenus.gasMenu(chain, fees, CONFIG.supportedChains, CHAINS));
    } catch { tgRender(msg.chat.id, telegramMenus.gasMenu(chain, null, CONFIG.supportedChains, CHAINS)); }
  }));

  bot.onText(/^\/stats(?:@\w+)?$/, withTelegramUser(async (msg, match, userId) => {
    const state = stateFor(userId);
    const stats = await botCommands.stats(userId);
    const minted = state.wallets.reduce((sum,w) => sum+(w.minted||0), 0);
    const pending = (await schedulerRepository.listForUser(userId)).filter(t => ['scheduled','retry','claimed','paused'].includes(t.status)).length;
    tgRender(msg.chat.id, { text: `📊 <b>GhostMint Stats</b>\n\n⬡ Wallets: <b>${state.wallets.length}</b>\n⏱ Pending: <b>${pending}</b>\n⚡ Minted: <b>${minted}</b>\n⏭ Skipped: <b>${stats.skipped}</b>\n✅ Success rate: <b>${stats.successRate}%</b>\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/canceltask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tgRender(msg.chat.id, { text: 'Task not found. Use /tasks.', parseMode: 'HTML' });
    setPendingConfirmation(msg.chat.id, async () => {
      const cancelled = await botCommands.controlTask(userId, 'cancel', id);
      return `✅ Task <b>${escapeTelegramHtml(cancelled.name)}</b> cancelled.`;
    });
    tgRender(msg.chat.id, { text: `Cancel task <b>${escapeTelegramHtml(task.name)}</b>? This cannot be undone.`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
  }));

  bot.onText(/^\/pausetask(?:@\w+)?\s+(.+)$/, withTelegramUser(async (msg, match, userId) => {
    const task = await botCommands.controlTask(userId, 'pause', match[1]);
    tgRender(msg.chat.id, { text: `⏸ Task <b>${escapeTelegramHtml(task.name)}</b> paused.`, parseMode: 'HTML' });
  }));

  bot.onText(/^\/resumetask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tgRender(msg.chat.id, { text: 'Task not found. Use /tasks.', parseMode: 'HTML' });
    setPendingConfirmation(msg.chat.id, async () => {
      const resumed = await botCommands.controlTask(userId, 'resume', id);
      return `▶ Task <b>${escapeTelegramHtml(resumed.name)}</b> resumed.`;
    });
    tgRender(msg.chat.id, { text: `Resume task <b>${escapeTelegramHtml(task.name)}</b>?`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
  }));

  bot.onText(/^\/retrytask(?:@\w+)?\s+([0-9a-f-]+)$/i, withTelegramUser(async (msg, match, userId) => {
    const id = match[1];
    const task = (await botCommands.tasks(userId)).find(item => item.id === id);
    if (!task) return tgRender(msg.chat.id, { text: 'Task not found. Use /tasks.', parseMode: 'HTML' });
    setPendingConfirmation(msg.chat.id, async () => {
      const retried = await botCommands.controlTask(userId, 'retry', id);
      return `↻ Task <b>${escapeTelegramHtml(retried.name)}</b> queued for retry.`;
    });
    tgRender(msg.chat.id, { text: `Retry task <b>${escapeTelegramHtml(task.name)}</b>?`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
  }));

  bot.onText(/^\/removewallet(?:@\w+)?\s+(.+)$/i, withTelegramUser(async (msg, match, userId) => {
    const label = match[1].trim();
    const owned = botCommands.wallets(userId).find(item => item.label === label);
    if (!owned) return tgRender(msg.chat.id, { text: `Wallet "${escapeTelegramHtml(label)}" not found. Use /wallets.`, parseMode: 'HTML' });
    setPendingConfirmation(msg.chat.id, async () => {
      const removed = await botCommands.removeWallet(userId, owned.label);
      return `✅ Wallet <b>${escapeTelegramHtml(removed)}</b> removed.`;
    });
    tgRender(msg.chat.id, { text: `Remove wallet <b>${escapeTelegramHtml(owned.label)}</b>? This cannot be undone.`, replyMarkup: confirmationKeyboard(), parseMode: 'HTML' });
  }));

} else {
  log('⚠️  No TELEGRAM_BOT_TOKEN — Telegram disabled.');
}

const botCommands = createBotCommandService({
  storage,
  identity,
  botSecurityRepository,
  broadcast: (userId, resource) => dashboardWebSockets.broadcastToUser(userId, {type:`${resource}.changed`}),
  schedulerRepository,
  providerService,
  contractValueResolver,
  seaDropDiscoveryService,
  openSeaService,
  priceFeedService,
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
  broadcastToUsers:(userIds,message)=>dashboardWebSockets.broadcastToUsers(userIds,message),
  supportedChains:CONFIG.supportedChains,
  checkAccountStatus:userId=>governance.checkAccountStatus(userId),
  loginRateLimiter:createCommandRateLimiter({limit:5,windowMs:60_000}),
  passwordLoginRateLimiter:createCommandRateLimiter({limit:5,windowMs:15*60_000}),
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
// Same data as the public /health above, but behind a session + owner check so it shows up inside
// the admin dashboard itself instead of only being reachable by hitting the bare endpoint by hand.
app.get('/api/admin/health', dashboardApi.requireSession, async (req,res) => {
  try { await governance.requireOwner(req.dashboardSession.userId); }
  catch { return res.status(403).json({error:'Owner access required'}); }
  const health=await readinessService.inspect();
  res.json({...health,uptime:Math.floor(process.uptime())});
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
