const { Wallet, formatEther } = require('ethers');
const { findOwnedWallet, stateForUser } = require('../identity/ownership');
const { ValidationError, requestSchemas } = require('../validation/domain');
const { paginate, pagination } = require('../pagination');
const { calculateStatistics } = require('../statistics/statisticsService');

function createBotCommandService(dependencies) {
  const { storage, schedulerRepository, providerService, governance, adminCommands, sniperService,
    socialWatchService, socialUsageService, targetPolicyService, triggerExecutionService, governanceRepository,
    triggerAuditRepository, transactionIntentRepository, gasService, supportedChains, chains, encryptPrivateKey, getState, executeMint,
    sniperRepository,
    ensureChainWatcher = () => {} } = dependencies;

  function state(userId) { return stateForUser(getState(), userId); }
  function wallet(userId, label) {
    const result = findOwnedWallet(getState(), userId, label);
    if (!result) throw new ValidationError({ field: 'walletLabel', message: 'was not found' });
    return result;
  }

  async function persistWallet(userId, input) {
    const validated = requestSchemas.walletCreate(input, {
      existingLabels: state(userId).wallets.map(item => item.label), supportedChains,
    });
    const saved = await storage.addWallet({ userId, label: validated.label, address: validated.address,
      chain: validated.chain, keyEnvelope: encryptPrivateKey(validated.privateKey), minted: 0, addedAt: Date.now() });
    getState().wallets.push(saved);
    return { label: saved.label, address: saved.address, chain: saved.chain };
  }

  async function createWallet(userId, input) {
    const generated = Wallet.createRandom();
    return persistWallet(userId, { ...input, privateKey: generated.privateKey });
  }

  function importWallet(userId, input) {
    return persistWallet(userId, input);
  }

  async function removeWallet(userId, label) {
    const validated = requestSchemas.walletDeletion({ label });
    const owned = wallet(userId, validated.label);
    await storage.deleteWallet(userId, owned.label);
    getState().wallets.splice(getState().wallets.indexOf(owned), 1);
    return owned.label;
  }

  async function walletBalance(userId, label) {
    const owned = wallet(userId, label);
    const balance = await providerService.perform(owned.chain, 'getBalance', provider => provider.getBalance(owned.address));
    return { ...owned, balance: formatEther(balance), symbol: chains[owned.chain].sym };
  }

  async function mint(userId, input) {
    const owned = wallet(userId, input.walletLabel);
    const validated = requestSchemas.mint({ ...input, chain: input.chain || owned.chain }, { supportedChains });
    return executeMint({ userId, wallet: owned, request: validated });
  }

  async function batchMint(userId, input) {
    const validated = requestSchemas.batchMint(input, { supportedChains });
    const results = [];
    for (const label of validated.walletLabels) {
      results.push(await mint(userId, { ...validated, walletLabel: label }));
    }
    return results;
  }

  async function createTask(userId, input) {
    const validated = requestSchemas.taskCreate(input, { supportedChains, now: Date.now() });
    wallet(userId, validated.walletLabel);
    const task = { userId, id: validated.id, name: validated.name, walletLabel: validated.walletLabel,
      contract: validated.contractAddress, fn: validated.functionName, qty: validated.quantity,
      price: validated.priceETH, gas: validated.gasGwei, mintTime: validated.mintTime,
      nextAttemptAt: validated.mintTime, status: 'scheduled', createdAt: Date.now(), maxAttempts: 3,
      idempotencyKey: `scheduled-mint:${userId}:${validated.id}` };
    await storage.saveTask(task);
    getState().tasks.push(task);
    return task;
  }

  async function controlTask(userId, action, id) {
    const validated = requestSchemas.taskDeletion({ id });
    const now = Date.now();
    const task = action === 'resume' || action === 'retry'
      ? await schedulerRepository[action](userId, validated.id, now)
      : await schedulerRepository[action](userId, validated.id);
    if (!task) throw new ValidationError({ field: 'id', message: `was not found or cannot be ${action}d` });
    const cached = getState().tasks.find(item => item.userId === userId && item.id === task.id);
    if (cached) Object.assign(cached, task);
    return task;
  }

  async function addPnl(userId, input) {
    const value = requestSchemas.pnlCreate(input);
    const saved = await storage.addPnl({ userId, nm: value.name, cost: value.cost, sale: value.sale,
      gas: value.gas, net: value.net, t: Date.now() });
    getState().pnl.unshift(saved);
    return saved;
  }

  async function deletePnl(userId, id) {
    const validated = requestSchemas.pnlDeletion({ id });
    const owned = state(userId).pnl.find(item => item.id === validated.id);
    if (!owned || !await storage.deletePnl(userId, validated.id)) throw new ValidationError({ field: 'id', message: 'was not found' });
    getState().pnl.splice(getState().pnl.indexOf(owned), 1);
    return validated.id;
  }

  async function createSniper(userId, input) {
    const validated = sniperService.validateCreate(input);
    wallet(userId, validated.walletLabel);
    const sniper = { ...validated, userId, active: input.active !== false, hits: 0, fails: 0,
      createdAt: Date.now() };
    await storage.saveSniper(sniper);
    getState().snipers.push(sniper);
    if (sniper.active) ensureChainWatcher(sniper.chain);
    return sniper;
  }

  async function removeSniper(userId,id) {
    const validated=requestSchemas.sniperDeletion({id});
    const current=state(userId).snipers.find(item=>item.id===validated.id);
    if(!current||!await storage.deleteSniper(userId,validated.id)) throw new ValidationError({field:'id',message:'was not found'});
    getState().snipers.splice(getState().snipers.indexOf(current),1);
    await targetPolicyService.reset(userId,{targetType:'sniper',targetId:validated.id});
    return validated.id;
  }

  async function updateSniper(userId, id, patch) {
    const validated = requestSchemas.sniperDeletion({ id });
    const current = state(userId).snipers.find(item => item.id === validated.id);
    if (!current) throw new ValidationError({ field: 'id', message: 'was not found' });
    const updated = sniperService.validatePatch(current, patch);
    await storage.saveSniper(updated);
    Object.assign(current, updated);
    if (current.active) ensureChainWatcher(current.chain);
    return current;
  }

  async function gas(chain = 'ethereum') {
    if (!supportedChains.includes(chain)) throw new ValidationError({ field: 'chain', message: `must be one of: ${supportedChains.join(', ')}` });
    return gasService.lookup(chain);
  }

  async function pageFrom(repositoryMethod,fallback,userId,input) {const p=pagination(input);if(repositoryMethod){const result=await repositoryMethod(userId,{limit:p.pageSize,offset:p.offset});return {...p,total:result.total,totalPages:Math.max(1,Math.ceil(result.total/p.pageSize)),items:result.items};}return paginate(fallback(),p);}

  async function stats(userId) {const rows=sniperRepository?.statsForUser?await sniperRepository.statsForUser(userId):[];
    const sniperEvents=rows.flatMap(row=>Array.from({length:row.count},()=>({state:row.state})));
    return calculateStatistics({activity:state(userId).activity,sniperEvents});}

  return {
    createWallet, importWallet, removeWallet, walletBalance, mint, batchMint, createTask, controlTask, addPnl, deletePnl,
    createSniper, updateSniper, removeSniper, gas,
    wallets: userId => state(userId).wallets,
    tasks: userId => schedulerRepository.listForUser(userId),
    tasksPage:(userId,input)=>pageFrom(schedulerRepository.listPageForUser?.bind(schedulerRepository),()=>state(userId).tasks,userId,input),
    activity: userId => state(userId).activity.slice(0, 10),
    activityPage:(userId,input)=>pageFrom(storage.listActivityPage?.bind(storage),()=>state(userId).activity,userId,input),
    pnl: userId => state(userId).pnl,
    snipers: userId => state(userId).snipers,
    createWatchRule: (userId, input) => socialWatchService.create(userId, input),
    updateWatchRule: (userId, id, input) => socialWatchService.update(userId, id, input),
    disableWatchRule: (userId, id) => socialWatchService.disable(userId, id),
    removeWatchRule: async (userId, id) => { const result=await socialWatchService.remove(userId,id);
      await targetPolicyService.reset(userId,{targetType:'social_rule',targetId:id}); return result; },
    watchRules: userId => socialWatchService.list(userId),
    socialUsage: (userId, period) => socialUsageService.summary(userId, period),
    targetPolicy: (userId, targetType, targetId) => targetPolicyService.get(userId, targetType, targetId),
    updateTargetPolicy: (userId, input) => targetPolicyService.save(userId, input),
    requestTargetBypass: (userId, input) => targetPolicyService.requestBypass(userId, input),
    confirmTargetBypass: (userId, input) => targetPolicyService.confirmBypass(userId, input),
    resetTargetPolicy: (userId, input) => targetPolicyService.reset(userId, input),
    applyTargetPreset: async (userId, input) => targetPolicyService.applyPreset(userId,input,
      await governanceRepository.getPreset(input.presetKey)),
    confirmTrigger: (userId, requestId, confirmation) => triggerExecutionService.confirm(userId, requestId, confirmation),
    triggerAudit: userId => triggerAuditRepository.listAudit(userId),
    pendingConfirmations: userId => triggerAuditRepository.listPendingRequests(userId),
    pendingTransactions: userId => transactionIntentRepository.listNonFinalForUser(userId),
    transactionsPage:(userId,input)=>pageFrom(transactionIntentRepository.listPageForUser?.bind(transactionIntentRepository),()=>[],userId,input),
    stats,
    selectMode: (userId, preset) => governance.selectPreset(userId, preset),
    admin: (userId, input) => adminCommands.execute(userId, input),
  };
}

module.exports = { createBotCommandService };
