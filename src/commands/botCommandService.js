const { Wallet, formatEther, isAddress, parseEther } = require('ethers');
const { findOwnedWallet, stateForUser } = require('../identity/ownership');
const { ValidationError, requestSchemas } = require('../validation/domain');
const { paginate, pagination } = require('../pagination');
const { calculateStatistics } = require('../statistics/statisticsService');
const { detectContractChain } = require('../mint/chainDetector');

function createBotCommandService(dependencies) {
  const { storage, schedulerRepository, providerService, governance, adminCommands, sniperService,
    socialWatchService, socialUsageService, targetPolicyService, triggerExecutionService, governanceRepository,
    triggerAuditRepository, transactionIntentRepository, gasService, supportedChains, chains, encryptPrivateKey, getState, executeMint,
    sniperRepository, mintService, previewMint, executePreparedMint, identity, contractValueResolver,
    ensureChainWatcher = () => {} } = dependencies;

  // Discord's /mint no longer has a price input; Telegram's guided flow doesn't ask for one either.
  // If the caller already gave a price (either field name the schema accepts), that stands -- an
  // explicit value always wins over a probed one. Only probes when both chain and contract are
  // present; otherwise leaves it alone so normal validation reports the real missing field.
  async function resolvePriceIfMissing(input, chain) {
    if (input.priceETH !== undefined && input.priceETH !== null) return input;
    if (input.price !== undefined && input.price !== null) return input;
    if (!contractValueResolver || !chain || !input.contractAddress) return input;
    const resolved = await contractValueResolver.resolve(chain, input.contractAddress);
    if (!resolved.price) {
      throw new ValidationError({ field: 'priceETH', message: 'could not be determined from this contract; please provide it' });
    }
    return { ...input, priceETH: formatEther(BigInt(resolved.price.value)) };
  }

  // Dashboard-facing counterpart to what Telegram/Discord's guided /mint flow already does
  // automatically: find which configured chain the contract lives on, then probe it for a mint
  // price the same way resolvePriceIfMissing does. mint(uint256) is the assumption the guided
  // flow already makes for a plain quantity-only mint -- this mirrors that rather than inventing
  // a second convention, so a dashboard user gets the same result a bot user would. An unresolved
  // price returns valueWei:null (never 0) so a paid contract can never look like a free one.
  async function detectMintContract(userId, input) {
    const contractAddress = String(input.contractAddress || '').trim();
    if (!isAddress(contractAddress)) throw new ValidationError({ field: 'contractAddress', message: 'must be a valid Ethereum address' });
    const chain = await detectContractChain({ providerService, supportedChains, contractAddress });
    if (!chain) throw new ValidationError({ field: 'contractAddress', message: 'could not be found on any supported chain' });
    const quantity = Math.max(1, Math.min(100, Math.floor(Number(input.quantity)) || 1));
    const resolved = contractValueResolver ? await contractValueResolver.resolve(chain, contractAddress) : { price: null, maxSupply: null, maxPerWallet: null };
    const priceKnown = Boolean(resolved.price);
    return {
      chain,
      methodSignature: 'mint(uint256)',
      arguments: [quantity],
      valueWei: priceKnown ? (BigInt(resolved.price.value) * BigInt(quantity)).toString() : null,
      priceKnown,
      maxSupply: resolved.maxSupply?.value ?? null,
      maxPerWallet: resolved.maxPerWallet?.value ?? null,
    };
  }

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

  // A wallet's stored chain is just its nominal home chain now (see DEFAULT_EVM_CHAIN in the
  // dashboard) -- the same address is valid on every configured EVM chain, and it can mint on any
  // of them. Checking only owned.chain would silently hide funds sent to the wallet on any other
  // chain, so this checks all of them and reports a per-chain breakdown instead of one number. A
  // single chain's RPC failing (rather than reporting a real zero) is reported as null, not
  // dropped, so the caller can tell "no funds here" apart from "couldn't check this one."
  async function walletBalance(userId, label) {
    const owned = wallet(userId, label);
    const balances = await Promise.all(supportedChains.map(async chain => {
      try {
        const balance = await providerService.perform(chain, 'getBalance', provider => provider.getBalance(owned.address));
        return { chain, balance: formatEther(balance), symbol: chains[chain].sym };
      } catch {
        return { chain, balance: null, symbol: chains[chain].sym };
      }
    }));
    return { ...owned, balances };
  }

  async function mint(userId, input) {
    const owned = wallet(userId, input.walletLabel);
    const chain = input.chain || owned.chain;
    const withPrice = await resolvePriceIfMissing(input, chain);
    const validated = requestSchemas.mint({ ...withPrice, chain }, { supportedChains });
    return executeMint({ userId, wallet: owned, request: validated });
  }

  async function batchMint(userId, input) {
    const withPrice = await resolvePriceIfMissing(input, input.chain);
    const validated = requestSchemas.batchMint(withPrice, { supportedChains });
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

  async function updatePnl(userId,id,input) {
    const validatedId=requestSchemas.pnlDeletion({id}).id;
    const owned=state(userId).pnl.find(item=>item.id===validatedId);
    if(!owned) throw new ValidationError({field:'id',message:'was not found'});
    const value=requestSchemas.pnlCreate(input);
    const saved=await storage.updatePnl(userId,validatedId,{nm:value.name,cost:value.cost,sale:value.sale,
      gas:value.gas,net:value.net});
    if(!saved) throw new ValidationError({field:'id',message:'was not found'});
    Object.assign(owned,saved);return saved;
  }

  // Wallets store one nominal home chain (see DEFAULT_EVM_CHAIN in the dashboard), but an EVM
  // address is valid on every EVM chain, and mint()/batchMint() already let a mint target any
  // supported chain regardless of the wallet's stored chain. This used to also require
  // input.chain to match owned.chain, which would have blocked minting on anything but a
  // wallet's default chain -- removed so preview/confirm behaves the same as mint()/batchMint().
  async function prepareMint(userId,input) {
    const owned=wallet(userId,input.walletLabel);
    const prepared=input.presetName
      ? await mintService.preparePreset(userId,input.presetName,owned.address)
      : await mintService.prepare({...input,walletAddress:owned.address,chain:input.chain||owned.chain});
    const simulation=await previewMint({userId,wallet:owned,prepared,gasGwei:input.gasGwei});
    return {wallet:{label:owned.label,address:owned.address,chain:owned.chain},prepared,simulation};
  }

  async function submitPreparedMint(userId,value) {
    const owned=wallet(userId,value.wallet.label);
    return executePreparedMint({userId,wallet:owned,prepared:value.prepared,gasGwei:value.gasGwei});
  }

  async function createSniper(userId, input) {
    const validated = sniperService.validateCreate(input);
    wallet(userId, validated.walletLabel);
    await enforceSniperGovernance(userId,validated);
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
    await enforceSniperGovernance(userId,updated);
    await storage.saveSniper(updated);
    Object.assign(current, updated);
    if (current.active) ensureChainWatcher(current.chain);
    return current;
  }

  async function gas(chain = 'ethereum') {
    if (!supportedChains.includes(chain)) throw new ValidationError({ field: 'chain', message: `must be one of: ${supportedChains.join(', ')}` });
    return gasService.lookup(chain);
  }

  async function enforceSniperGovernance(userId,value) {
    const effective=await governanceRepository.getEffectiveGovernance(userId,value.chain);
    if(effective.isOwner)return;
    if(parseEther(String(value.maxValueETH))>effective.maxTransactionValueWei) throw new ValidationError({field:'maxValueETH',message:'exceeds your effective governance ceiling'});
    if(parseEther(String(value.dailySpendingCapETH))>effective.dailySpendingBudgetWei) throw new ValidationError({field:'dailySpendingCapETH',message:'exceeds your effective governance ceiling'});
    if(value.maxGasGwei>effective.gasCeilingGwei) throw new ValidationError({field:'maxGasGwei',message:'exceeds your effective governance ceiling'});
  }

  async function targetDetails(userId,targetType,targetId) {
    const policy=await targetPolicyService.get(userId,targetType,targetId);
    const target=targetType==='sniper'?state(userId).snipers.find(item=>item.id===targetId)
      :(await socialWatchService.list(userId)).find(item=>item.id===targetId);
    if(!target)throw new ValidationError({field:'targetId',message:'was not found'});
    const chain=target.chain||'ethereum';
    const governance=await governanceRepository.getEffectiveGovernance(userId,chain);
    return {targetType,targetId,label:target.label||target.name,chain,policy,governance};
  }

  async function pageFrom(repositoryMethod,fallback,userId,input,searchFields) {const p=pagination(input);const search=typeof input?.search==='string'?input.search.trim():'';if(repositoryMethod){const result=await repositoryMethod(userId,{limit:p.pageSize,offset:p.offset,search});return {...p,total:result.total,totalPages:Math.max(1,Math.ceil(result.total/p.pageSize)),items:result.items};}const source=fallback();const items=search&&searchFields?source.filter(item=>searchFields.some(field=>String(item[field]||'').toLowerCase().includes(search.toLowerCase()))):source;return paginate(items,p);}

  async function stats(userId) {const rows=sniperRepository?.statsForUser?await sniperRepository.statsForUser(userId):[];
    const sniperEvents=rows.flatMap(row=>Array.from({length:row.count},()=>({state:row.state})));
    return calculateStatistics({activity:state(userId).activity,sniperEvents});}

  return {
    createWallet, importWallet, removeWallet, walletBalance, mint, batchMint, createTask, controlTask, addPnl, updatePnl, deletePnl,
    prepareMint,submitPreparedMint,detectMintContract,mintPresets:userId=>mintService.listPresets(userId),
    createSniper, updateSniper, removeSniper, gas,
    sniperEvents:userId=>sniperRepository.listRecentForUser(userId),
    wallets: userId => state(userId).wallets,
    tasks: userId => schedulerRepository.listForUser(userId),
    tasksPage:(userId,input)=>pageFrom(schedulerRepository.listPageForUser?.bind(schedulerRepository),()=>state(userId).tasks,userId,input,['name','walletLabel']),
    activity: userId => state(userId).activity.slice(0, 10),
    activityPage:(userId,input)=>pageFrom(storage.listActivityPage?.bind(storage),()=>state(userId).activity,userId,input,['title','walletLabel']),
    pnl: userId => state(userId).pnl,
    snipers: userId => state(userId).snipers,
    createWatchRule: (userId, input) => socialWatchService.create(userId, input),
    updateWatchRule: (userId, id, input) => socialWatchService.update(userId, id, input),
    disableWatchRule: (userId, id) => socialWatchService.disable(userId, id),
    removeWatchRule: async (userId, id) => { const result=await socialWatchService.remove(userId,id);
      await targetPolicyService.reset(userId,{targetType:'social_rule',targetId:id}); return result; },
    watchRules: userId => socialWatchService.list(userId),
    watchEvents:userId=>socialWatchService.recentTriggers(userId),
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
    targetDetails,
    modePresets:()=>governanceRepository.listPresets(),
    pendingTransactions: userId => transactionIntentRepository.listNonFinalForUser(userId),
    transactionsPage:(userId,input)=>pageFrom(transactionIntentRepository.listPageForUser?.bind(transactionIntentRepository),()=>[],userId,input),
    stats,
    selectMode: (userId, preset) => governance.selectPreset(userId, preset),
    admin: (userId, input) => adminCommands.execute(userId, input),
    isOwner:userId=>governanceRepository.isOwner(userId),
    isRootOwner:userId=>governanceRepository.isRootOwner(userId),
    adminOverview:userId=>governance.dashboardOverview(userId),
    adminEffective:(userId,input)=>governance.effectiveForLinkedUser(userId,input),
    linkCode:userId=>identity.createLinkCode(userId),
  };
}

module.exports = { createBotCommandService };
