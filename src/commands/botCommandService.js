const { Wallet, formatEther, isAddress, parseEther } = require('ethers');
const { URL } = require('node:url');
const { findOwnedWallet, stateForUser } = require('../identity/ownership');
const { ValidationError, requestSchemas, LIMITS } = require('../validation/domain');
const { paginate, pagination } = require('../pagination');
const { calculateStatistics } = require('../statistics/statisticsService');
const { detectContractChain } = require('../mint/chainDetector');
const { computeSeaDropValueWei } = require('../mint/seaDropCall');
const { SEADROP_MINT_SIGNATURE } = require('../mint/seaDropRegistry');
const { createWalletBalanceCache } = require('./walletBalanceCache');

// The four controls a scheduled mint accepts, each with the past participle its error message
// needs. `${action}d` got half of them wrong -- "canceld" and "retryd" both reached the user
// verbatim in the dashboard's error toast. "cancelled" carries the double l the rest of the
// codebase uses, including the status value the scheduler writes (schedulerRepository.js:138).
// This also serves as the ALLOWLIST for controlTask: see the note there.
const TASK_CONTROLS = Object.freeze({
  cancel: 'cancelled', pause: 'paused', resume: 'resumed', retry: 'retried',
});

function createBotCommandService(dependencies) {
  const { storage, schedulerRepository, providerService, governance, adminCommands, sniperService,
    socialWatchService, socialUsageService, targetPolicyService, triggerExecutionService, governanceRepository,
    triggerAuditRepository, transactionIntentRepository, gasService, supportedChains, chains, encryptPrivateKey, getState, executeMint, executeSend,
    sniperRepository, mintService, previewMint, executePreparedMint, identity, contractValueResolver, seaDropDiscoveryService, openSeaService, priceFeedService,
    exportRawKey, exportKeystore, botSecurityRepository,
    ensureChainWatcher = () => {}, broadcast = () => {}, walletBalanceCache = createWalletBalanceCache() } = dependencies;

  // Discord's /mint no longer has a price input; Telegram's guided flow doesn't ask for one either.
  // If the caller already gave a price (either field name the schema accepts), that stands -- an
  // explicit value always wins over a probed one. Only probes when both chain and contract are
  // present; otherwise leaves it alone so normal validation reports the real missing field.
  // A SeaDrop drop with a known PublicDrop price is deliberately left with no priceETH here --
  // executeMint's own SeaDrop branch computes valueWei directly from the discovered mintPriceWei
  // (in wei, not the lossy ETH-string round trip this function produces), so forcing a priceETH
  // here would just be discarded downstream. If SeaDrop's price genuinely can't be read either,
  // this still falls through to the same "please provide it" error as any other contract.
  async function resolvePriceIfMissing(input, chain) {
    if (input.priceETH !== undefined && input.priceETH !== null) return input;
    if (input.price !== undefined && input.price !== null) return input;
    if (!chain || !input.contractAddress) return input;
    if (contractValueResolver) {
      const resolved = await contractValueResolver.resolve(chain, input.contractAddress);
      if (resolved.price) return { ...input, priceETH: formatEther(BigInt(resolved.price.value)) };
    }
    if (seaDropDiscoveryService) {
      const seaDrop = await seaDropDiscoveryService.resolve(chain, input.contractAddress);
      if (seaDrop.address && seaDrop.publicDrop) return input;
    }
    if (!contractValueResolver && !seaDropDiscoveryService) return input;
    throw new ValidationError({ field: 'priceETH', message: 'could not be determined from this contract; please provide it' });
  }

  // Only SeaDrop drops have a real on-chain "opening time" (PublicDrop.startTime) -- a plain
  // mint(uint256) contract has no equivalent concept anywhere (on-chain or otherwise), so this
  // leaves mintTime untouched in that case and normal validation still requires it explicitly. A
  // startTime that has already passed is also left alone rather than scheduling a task in the
  // past, which validation would reject anyway -- the drop is already open, so an immediate /mint
  // is the right move, not a scheduled task.
  async function resolveMintTimeIfMissing(input, chain) {
    if (input.mintTime !== undefined && input.mintTime !== null && input.mintTime !== '') return input;
    if (!chain || !input.contractAddress || !seaDropDiscoveryService) return input;
    const seaDrop = await seaDropDiscoveryService.resolve(chain, input.contractAddress);
    const startTime = seaDrop.publicDrop?.startTime;
    if (seaDrop.address && startTime && startTime * 1000 > Date.now()) {
      return { ...input, mintTime: new Date(startTime * 1000).toISOString() };
    }
    return input;
  }

  // displayPrice is purely informational context for "what is this collection worth" -- it must
  // never be confused with priceETH/valueWei above, which is the amount an actual mint transaction
  // will send. A sold-out collection's mint price is no longer obtainable (nobody can mint at it),
  // so the display switches to OpenSea's floor price instead; a real floor price of exactly 0 is
  // shown as 0, never hidden or treated as "unavailable" (same nullish-not-truthy convention as the
  // rest of this app). USD is best-effort only -- a missing price feed or unmapped chain symbol
  // just omits it, same "unknown is fine" philosophy as everything else in this function.
  async function resolveDisplayPrice({ chain, soldOut, mintPriceKnown, mintPriceWeiPerItem, floorPrice }) {
    const eth = soldOut
      ? (floorPrice === null || floorPrice === undefined ? null : floorPrice)
      : (mintPriceKnown ? Number(formatEther(mintPriceWeiPerItem)) : null);
    if (eth === null) return null;
    const sym = chains[chain]?.sym;
    const usdRate = priceFeedService && sym ? await priceFeedService.getUsdPrice(sym) : null;
    return { eth, usd: usdRate !== null && usdRate !== undefined ? eth * usdRate : null, source: soldOut ? 'floor' : 'mint' };
  }

  // Dashboard-facing counterpart to what Telegram/Discord's guided /mint flow already does
  // automatically: find which configured chain the contract lives on, then figure out how to mint
  // it without asking the user to know or supply that shape themselves. SeaDrop tokens are tried
  // first since they don't implement any whitelisted mint(...) signature at all -- their real entry
  // point is a separate SeaDrop core contract (see seaDropDiscoveryService.js/seaDropCall.js) -- and
  // everything else falls back to the plain mint(uint256) assumption the guided flow already makes.
  // A drop whose price genuinely can't be read returns valueWei:null (never 0), and a SeaDrop core
  // that can't be auto-discovered returns seaDropAddress:null so the dashboard can fall back to a
  // manually-entered one -- "unknown" is always a valid outcome here, never a thrown error.
  // Section Q: recognizes an opensea.io collection link the same way every entry point that used
  // to check isAddress(input) directly already recognized a bare contract address -- pasting a
  // link should behave identically to pasting the contract it refers to. Shared here (rather than
  // duplicated per platform) since Telegram's server.js and discordBot.js both need it for their
  // own bare-address/link detection and guided-flow contract-input steps. Slug charset/length
  // mirror validate_slug in the OSNM-Z reference reviewed for Section T-Z.
  function parseOpenSeaCollectionSlug(input) {
    let url;
    try {
      url = new URL(String(input).trim());
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || !['opensea.io', 'www.opensea.io'].includes(url.hostname)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const slug = segments[0] === 'collection' ? segments[1] : null;
    if (!slug || slug.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    return slug;
  }

  // Resolves whatever a user pasted -- a contract address or an OpenSea collection link -- to the
  // contract address detectMintContract already expects. Unrecognized input (including a link
  // OpenSea couldn't map to a chain this app supports) returns null exactly like an invalid
  // address always did, so every caller's existing "not a valid address" error path is unchanged.
  async function resolveMintContractInput(input) {
    if (isAddress(input)) return input;
    if (!openSeaService) return null;
    const slug = parseOpenSeaCollectionSlug(input);
    if (!slug) return null;
    const resolved = await openSeaService.resolveCollectionContract(slug, supportedChains);
    return resolved ? resolved.contractAddress : null;
  }

  async function detectMintContract(userId, input) {
    const contractAddress = String(input.contractAddress || '').trim();
    if (!isAddress(contractAddress)) throw new ValidationError({ field: 'contractAddress', message: 'must be a valid Ethereum address' });
    const chain = await detectContractChain({ providerService, supportedChains, contractAddress });
    if (!chain) throw new ValidationError({ field: 'contractAddress', message: 'could not be found on any supported chain' });
    const quantity = Math.max(1, Math.min(100, Math.floor(Number(input.quantity)) || 1));
    // Display-only, same "unknown is fine" shape as everything else here -- a missing API key or
    // an OpenSea outage never blocks detection, it just leaves these fields null.
    const openSea = openSeaService ? await openSeaService.getCollectionMetadata(chain, contractAddress) : null;

    // Section AD Tier 1 (collection info card): opt-in and skipped entirely by the ordinary mint
    // flow, which has no use for it and shouldn't pay its extra RPC/API cost on every paste. Both
    // probes below are deliberately live, not the cached values this function already computes
    // elsewhere (resolved.totalMinted below, openSea.floorPrice above) -- the card's whole point
    // is a Refresh button that actually refreshes, not one that replays whatever was cached the
    // first time this contract was ever looked up. Computed once here, shared by both the SeaDrop
    // and plain-mint branches below, since collection-level stats don't depend on mint mechanism.
    let stats = null;
    if (input.includeStats) {
      const [liveTotalMinted, liveStats] = await Promise.all([
        contractValueResolver ? contractValueResolver.probeTotalMinted(chain, contractAddress) : null,
        openSeaService ? openSeaService.getCollectionStats(chain, contractAddress) : null,
      ]);
      const totalMintedValue = liveTotalMinted ? Number(liveTotalMinted.value) : null;
      const floorPrice = liveStats?.floorPrice ?? null;
      stats = {
        totalMinted: totalMintedValue,
        floorPrice,
        floorPriceSymbol: liveStats?.floorPriceSymbol ?? null,
        numOwners: liveStats?.numOwners ?? null,
        volume: liveStats?.volume ?? { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null },
        sales: liveStats?.sales ?? { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null },
        // floor price x current minted supply -- deliberately current supply, not maxSupply, since
        // they diverge for an in-progress mint and market cap means circulating supply x price
        // everywhere else this term is used.
        marketCap: floorPrice !== null && totalMintedValue !== null ? floorPrice * totalMintedValue : null,
      };
    }

    const seaDrop = seaDropDiscoveryService
      ? await seaDropDiscoveryService.resolve(chain, contractAddress)
      : { address: null, publicDrop: null, feeRecipient: null };
    if (seaDrop.address) {
      const priceKnown = Boolean(seaDrop.publicDrop);
      // SeaDrop's own PublicDrop struct has no current-supply field -- its endTime having already
      // passed is the signal available here, distinct from the totalMinted>=maxSupply comparison
      // the plain-mint branch below uses.
      const soldOut = Boolean(seaDrop.publicDrop?.endTime && seaDrop.publicDrop.endTime * 1000 <= Date.now());
      const displayPrice = await resolveDisplayPrice({ chain, soldOut, mintPriceKnown: priceKnown,
        mintPriceWeiPerItem: priceKnown ? BigInt(seaDrop.publicDrop.mintPriceWei) : null, floorPrice: openSea?.floorPrice });
      return {
        chain,
        isSeaDrop: true,
        methodSignature: SEADROP_MINT_SIGNATURE,
        seaDropAddress: seaDrop.address,
        arguments: [seaDrop.feeRecipient || null, '$wallet', quantity],
        valueWei: priceKnown ? computeSeaDropValueWei({ mintPriceWei: seaDrop.publicDrop.mintPriceWei, quantity }).toString() : null,
        priceKnown,
        maxSupply: null,
        maxPerWallet: seaDrop.publicDrop?.maxTotalMintableByWallet ?? null,
        // Real on-chain SeaDrop PublicDrop fields (unix seconds) -- null for a drop with no known
        // PublicDrop yet, not "no opening time exists." Non-SeaDrop contracts have no equivalent
        // on-chain concept, so these stay null in the branch below.
        startTime: seaDrop.publicDrop?.startTime ?? null,
        endTime: seaDrop.publicDrop?.endTime ?? null,
        collection: openSea,
        soldOut,
        displayPrice,
        stats,
      };
    }

    const resolved = contractValueResolver
      ? await contractValueResolver.resolve(chain, contractAddress)
      : { price: null, maxSupply: null, maxPerWallet: null, totalMinted: null };
    const priceKnown = Boolean(resolved.price);
    const soldOut = Boolean(resolved.maxSupply?.value && resolved.totalMinted?.value
      && BigInt(resolved.totalMinted.value) >= BigInt(resolved.maxSupply.value));
    const displayPrice = await resolveDisplayPrice({ chain, soldOut, mintPriceKnown: priceKnown,
      mintPriceWeiPerItem: priceKnown ? BigInt(resolved.price.value) : null, floorPrice: openSea?.floorPrice });
    return {
      chain,
      isSeaDrop: false,
      methodSignature: 'mint(uint256)',
      seaDropAddress: null,
      arguments: [quantity],
      valueWei: priceKnown ? (BigInt(resolved.price.value) * BigInt(quantity)).toString() : null,
      priceKnown,
      maxSupply: resolved.maxSupply?.value ?? null,
      maxPerWallet: resolved.maxPerWallet?.value ?? null,
      startTime: null,
      endTime: null,
      collection: openSea,
      soldOut,
      displayPrice,
      stats,
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
    broadcast(userId, 'wallets');
    return { label: saved.label, address: saved.address, chain: saved.chain };
  }

  async function createWallet(userId, input) {
    const generated = Wallet.createRandom();
    return persistWallet(userId, { ...input, privateKey: generated.privateKey });
  }

  function importWallet(userId, input) {
    return persistWallet(userId, input);
  }

  // Owner-only: import many private keys in one call (dashboard and Discord both collect these as
  // a single comma-separated paste, split before reaching here). Each key is imported through the
  // exact same persistWallet() a single import uses -- no bypass of validation, encryption, or the
  // per-user label-uniqueness check -- and one bad key is reported per-entry rather than aborting
  // the rest of the batch, since a single typo shouldn't cost the whole paste. Labels are
  // auto-generated (labelPrefix-N, deduped against both existing wallets and labels already
  // claimed earlier in this same batch) since the caller supplies only keys, not one label per key.
  async function importWalletsBatch(userId, { privateKeys, chain, labelPrefix }) {
    await governance.requireOwner(userId);
    if (!Array.isArray(privateKeys) || privateKeys.length < 1 || privateKeys.length > LIMITS.batchWalletImport) {
      throw new ValidationError({ field: 'privateKeys', message: `must contain 1-${LIMITS.batchWalletImport} private keys` });
    }
    const prefix = String(labelPrefix || 'wallet').trim().slice(0, 40) || 'wallet';
    const claimed = new Set(state(userId).wallets.map(item => item.label.toLowerCase()));
    const results = [];
    for (let index = 0; index < privateKeys.length; index += 1) {
      const privateKey = String(privateKeys[index] || '').trim();
      if (!privateKey) { results.push({ index, status: 'failed', error: 'empty private key' }); continue; }
      let label = `${prefix}-${index + 1}`;
      let suffix = 1;
      while (claimed.has(label.toLowerCase())) { suffix += 1; label = `${prefix}-${index + 1}-${suffix}`; }
      try {
        const saved = await persistWallet(userId, { label, chain, privateKey, importMethod: 'privateKey' });
        claimed.add(saved.label.toLowerCase());
        results.push({ index, status: 'success', label: saved.label, address: saved.address });
      } catch (error) {
        results.push({ index, status: 'failed',
          error: error instanceof ValidationError ? error.issues.map(issue => issue.message).join('; ') : 'import failed' });
      }
    }
    return results;
  }

  async function removeWallet(userId, label) {
    const validated = requestSchemas.walletDeletion({ label });
    const owned = wallet(userId, validated.label);
    await storage.deleteWallet(userId, owned.label);
    getState().wallets.splice(getState().wallets.indexOf(owned), 1);
    broadcast(userId, 'wallets');
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
    const cached = walletBalanceCache.get(userId, owned.label);
    if (cached) return { ...owned, balances: cached };
    const balances = await Promise.all(supportedChains.map(async chain => {
      try {
        const balance = await providerService.perform(chain, 'getBalance', provider => provider.getBalance(owned.address));
        return { chain, balance: formatEther(balance), symbol: chains[chain].sym };
      } catch {
        return { chain, balance: null, symbol: chains[chain].sym };
      }
    }));
    walletBalanceCache.set(userId, owned.label, balances);
    return { ...owned, balances };
  }

  // Called from logActivity's success branch (server.js), the single funnel every mint outcome --
  // bot, scheduled, sniper copy-mint -- already passes through, so a just-confirmed transaction is
  // never masked by a stale cached balance read.
  function invalidateBalance(userId, label) {
    walletBalanceCache.invalidate(userId, label);
  }

  // SEC-01, Telegram half: the raw decrypted key, for a chat message that self-deletes on a short
  // timer (server.js). Ownership is checked the same way every other wallet-scoped command checks
  // it (wallet() throws if this userId doesn't own this label) -- there is deliberately no other
  // gate here; rate limiting and the audit-log write are platform-layer concerns (see server.js's
  // finishExportKeyExecution and dashboard/api.js's exportWalletKey), matching how every other
  // command's rate limiting already lives at the platform adapter, not in this shared service.
  async function exportWalletKeyRaw(userId, label) {
    const owned = wallet(userId, label);
    return { label: owned.label, privateKey: await exportRawKey({ wallet: owned }) };
  }

  // SEC-01, web half: never returns the raw key at all -- exportKeystore (server.js) decrypts the
  // stored envelope and immediately re-encrypts it into a standard V3 keystore under the account
  // security password dashboard/api.js already verified before calling this, so the plaintext key
  // exists only inside that one server-side call.
  async function exportWalletKeystore(userId, label, password) {
    const owned = wallet(userId, label);
    const validated = requestSchemas.walletExport({ securityPassword: password });
    return { label: owned.label, keystore: await exportKeystore({ wallet: owned, password: validated.securityPassword }) };
  }

  async function mint(userId, input) {
    const owned = wallet(userId, input.walletLabel);
    const chain = input.chain || owned.chain;
    const withPrice = await resolvePriceIfMissing(input, chain);
    const validated = requestSchemas.mint({ ...withPrice, chain }, { supportedChains });
    return executeMint({ userId, wallet: owned, request: validated });
  }

  // A plain native-currency transfer -- unlike mint(), there's no contract/method/ABI to resolve,
  // so this skips mintService entirely and hands off straight to executeSend (wired in server.js to
  // call transactionEngine.submit directly), which still applies the same spend caps, gas ceiling,
  // and nonce queue every mint goes through.
  async function send(userId, input) {
    const owned = wallet(userId, input.walletLabel);
    const chain = input.chain || owned.chain;
    const validated = requestSchemas.send({ ...input, chain }, { supportedChains });
    return executeSend({ userId, wallet: owned, request: validated });
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

  // Price and opening time now default the same way mint()'s does -- an explicit value always
  // wins, otherwise probe the contract before falling back to requiring it. Chain resolution
  // mirrors mint()'s own owned.chain fallback rather than doing independent auto-detection here;
  // a guided flow that wants full chain auto-detection from a bare contract address (the way
  // startMintFlow does) resolves it upstream and passes chain in explicitly, same as it does for mint().
  async function createTask(userId, input) {
    const owned = wallet(userId, input.walletLabel);
    const chain = input.chain || owned.chain;
    const withPrice = await resolvePriceIfMissing({ ...input, contractAddress: input.contractAddress ?? input.contract }, chain);
    const withMintTime = await resolveMintTimeIfMissing(withPrice, chain);
    const validated = requestSchemas.taskCreate({ ...withMintTime, chain }, { supportedChains, now: Date.now() });
    const task = { userId, id: validated.id, name: validated.name, walletLabel: validated.walletLabel,
      contract: validated.contractAddress, fn: validated.functionName, qty: validated.quantity,
      price: validated.priceETH, gas: validated.gasGwei, mintTime: validated.mintTime,
      nextAttemptAt: validated.mintTime, status: 'scheduled', createdAt: Date.now(), maxAttempts: 3,
      idempotencyKey: `scheduled-mint:${userId}:${validated.id}` };
    await storage.saveTask(task);
    getState().tasks.push(task);
    broadcast(userId, 'tasks');
    return task;
  }

  async function controlTask(userId, action, id) {
    // `action` arrives straight off a request body (src/dashboard/api.js:213) and is dispatched as
    // schedulerRepository[action](...), so before this guard ANY method on the repository could be
    // reached -- complete, fail, attachIntent, recoverWithoutExecution -- called with the wrong
    // arguments. Nothing corrupted data (complete's UPDATE matched no rows and returned false),
    // but fail threw on destructuring and surfaced as a 500, and nothing stopped the call being
    // made at all. Telegram and Discord always pass literals; only the dashboard route is open.
    if (!Object.hasOwn(TASK_CONTROLS, action)) {
      throw new ValidationError({ field: 'action', message: 'must be one of cancel, pause, resume, retry' });
    }
    const validated = requestSchemas.taskDeletion({ id });
    const now = Date.now();
    const task = action === 'resume' || action === 'retry'
      ? await schedulerRepository[action](userId, validated.id, now)
      : await schedulerRepository[action](userId, validated.id);
    if (!task) throw new ValidationError({ field: 'id', message: `was not found or cannot be ${TASK_CONTROLS[action]}` });
    const cached = getState().tasks.find(item => item.userId === userId && item.id === task.id);
    if (cached) Object.assign(cached, task);
    broadcast(userId, 'tasks');
    return task;
  }

  async function addPnl(userId, input) {
    const value = requestSchemas.pnlCreate(input);
    const saved = await storage.addPnl({ userId, nm: value.name, cost: value.cost, sale: value.sale,
      gas: value.gas, net: value.net, t: Date.now() });
    getState().pnl.unshift(saved);
    broadcast(userId, 'pnl');
    return saved;
  }

  async function deletePnl(userId, id) {
    const validated = requestSchemas.pnlDeletion({ id });
    const owned = state(userId).pnl.find(item => item.id === validated.id);
    if (!owned || !await storage.deletePnl(userId, validated.id)) throw new ValidationError({ field: 'id', message: 'was not found' });
    getState().pnl.splice(getState().pnl.indexOf(owned), 1);
    broadcast(userId, 'pnl');
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
    Object.assign(owned,saved);
    broadcast(userId, 'pnl');
    return saved;
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
    broadcast(userId, 'snipers');
    return sniper;
  }

  async function removeSniper(userId,id) {
    const validated=requestSchemas.sniperDeletion({id});
    const current=state(userId).snipers.find(item=>item.id===validated.id);
    if(!current||!await storage.deleteSniper(userId,validated.id)) throw new ValidationError({field:'id',message:'was not found'});
    getState().snipers.splice(getState().snipers.indexOf(current),1);
    await targetPolicyService.reset(userId,{targetType:'sniper',targetId:validated.id});
    broadcast(userId, 'snipers');
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
    broadcast(userId, 'snipers');
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
    createWallet, importWallet, importWalletsBatch, removeWallet, walletBalance, invalidateBalance, exportWalletKeyRaw, exportWalletKeystore, mint, batchMint, send, createTask, controlTask, addPnl, updatePnl, deletePnl,
    prepareMint,submitPreparedMint,detectMintContract,resolveMintContractInput,parseOpenSeaCollectionSlug,mintPresets:userId=>mintService.listPresets(userId),
    createSniper, updateSniper, removeSniper, gas,
    sniperEvents:userId=>sniperRepository.listRecentForUser(userId),
    wallets: userId => state(userId).wallets,
    tasks: userId => schedulerRepository.listForUser(userId),
    tasksPage:(userId,input)=>pageFrom(schedulerRepository.listPageForUser?.bind(schedulerRepository),()=>state(userId).tasks,userId,input,['name','walletLabel']),
    activity: userId => state(userId).activity.slice(0, 10),
    activityPage:(userId,input)=>pageFrom(storage.listActivityPage?.bind(storage),()=>state(userId).activity,userId,input,['title','walletLabel']),
    pnl: userId => state(userId).pnl,
    snipers: userId => state(userId).snipers,
    createWatchRule: async (userId, input) => { const rule=await socialWatchService.create(userId, input);
      broadcast(userId,'watchrules'); return rule; },
    updateWatchRule: async (userId, id, input) => { const rule=await socialWatchService.update(userId, id, input);
      broadcast(userId,'watchrules'); return rule; },
    disableWatchRule: async (userId, id) => { const rule=await socialWatchService.disable(userId, id);
      broadcast(userId,'watchrules'); return rule; },
    removeWatchRule: async (userId, id) => { const result=await socialWatchService.remove(userId,id);
      await targetPolicyService.reset(userId,{targetType:'social_rule',targetId:id});
      broadcast(userId,'watchrules'); return result; },
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
    currentMode: async userId => (await governanceRepository.getEffectiveGovernance(userId, 'ethereum')).preset,
    advancedModesAllowed: async userId => (await governanceRepository.getEffectiveGovernance(userId, 'ethereum')).advancedModesAllowed,
    pendingTransactions: userId => transactionIntentRepository.listNonFinalForUser(userId),
    transactionsPage:(userId,input)=>pageFrom(transactionIntentRepository.listPageForUser?.bind(transactionIntentRepository),()=>[],userId,input),
    stats,
    selectMode: (userId, preset) => governance.selectPreset(userId, preset),
    admin: (userId, input) => adminCommands.execute(userId, input),
    isOwner:userId=>governanceRepository.isOwner(userId),
    isRootOwner:userId=>governanceRepository.isRootOwner(userId),
    listOwnerUserIds:()=>governanceRepository.listOwnerUserIds(),
    adminOverview:userId=>governance.dashboardOverview(userId),
    adminEffective:(userId,input)=>governance.effectiveForLinkedUser(userId,input),
    // The caller's own ceilings. Chain matters -- gasCeilingGwei comes from that chain's
    // defaults when neither a user override nor a group sets one -- so an unsupported chain is
    // rejected here rather than reaching defaultPolicy(), which throws a bare Error for an
    // unknown chain and would surface as a 500 instead of a validation failure.
    // async, not a sync throw. Every other command here rejects rather than throws, and the
    // dashboard's action() wrapper catches from an awaited promise -- a synchronous throw out of
    // an otherwise-promise-returning API escapes that wrapper and lands on the generic 500
    // handler, turning a validation failure into a server error.
    profileLimits:async(userId,chain)=>{
      if(!supportedChains.includes(chain))throw new ValidationError({field:'chain',message:`must be one of: ${supportedChains.join(', ')}`});
      return governance.limitsForSelf(userId,chain);
    },
    // Owner-only cross-user visibility -- every one of these already takes an explicit userId
    // rather than deriving "the caller" internally, so the only thing missing is the owner gate
    // before pointing that userId at someone other than the caller.
    adminUserWallets:async(callerUserId,targetUserId)=>{await governance.requireOwner(callerUserId);return state(targetUserId).wallets;},
    adminUserActivity:async(callerUserId,targetUserId,input)=>{await governance.requireOwner(callerUserId);
      return pageFrom(storage.listActivityPage?.bind(storage),()=>state(targetUserId).activity,targetUserId,input,['title','walletLabel']);},
    adminUserTasks:async(callerUserId,targetUserId,input)=>{await governance.requireOwner(callerUserId);
      return pageFrom(schedulerRepository.listPageForUser?.bind(schedulerRepository),()=>state(targetUserId).tasks,targetUserId,input,['name','walletLabel']);},
    adminUserPnl:async(callerUserId,targetUserId)=>{await governance.requireOwner(callerUserId);return state(targetUserId).pnl;},
    adminSecurityAudit:async(callerUserId,input)=>{await governance.requireOwner(callerUserId);return botSecurityRepository.listRecent(input);},
    linkCode:userId=>identity.createLinkCode(userId),
  };
}

module.exports = { createBotCommandService };
