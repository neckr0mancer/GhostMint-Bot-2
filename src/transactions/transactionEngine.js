const { Wallet, keccak256, parseUnits } = require('ethers');
const { WalletNonceQueue } = require('./nonceQueue');
const { describeSeaDropError } = require('../mint/seaDropErrors');
const { createFeeDataCache } = require('./feeDataCache');
const { extractMintedTokenIds } = require('./mintReceiptTokens');

const FINAL_STATES = new Set(['confirmed', 'reverted', 'replaced']);

// See submit()'s useFastPath: abandon a slow primary RPC after one quick attempt instead of the
// provider service's own conservative default (10s x 2 attempts per URL) -- only ever applied to
// pre-broadcast reads for scheduled/Degen mints, never to the broadcast itself.
const FAST_RPC_TIMEOUT_MS = 3_000;
const FAST_RPC_RETRIES = 0;

class TransactionSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionSafetyError';
    this.code = code;
  }
}

function asBigInt(value, name) {
  try { return BigInt(value); }
  catch { throw new TransactionSafetyError('INVALID_TRANSACTION', `${name} must be an integer amount in wei`); }
}

function feePerGas(transaction) {
  return transaction.maxFeePerGasWei ?? transaction.gasPriceWei;
}

// Applies a mode preset's gasPriceMultiplier (Section C: "degen" bids gas up, "normie" pays the
// network's own estimate) to an auto-computed fee value only -- never to a caller-explicit
// gasPriceWei/maxFeePerGasWei/maxPriorityFeePerGasWei, which is an intentional override the
// multiplier must not silently change. Integer math throughout: BigInt has no native float
// multiplication, so the multiplier is scaled to a fixed-point ratio (4 decimal places) instead of
// converting to Number, which would lose precision on large wei values.
function applyGasMultiplier(weiValue, multiplier) {
  if (weiValue === null || weiValue === undefined) return weiValue;
  if (!multiplier || multiplier === 1) return weiValue;
  const scaled = BigInt(Math.round(multiplier * 10_000));
  return (BigInt(weiValue) * scaled) / 10_000n;
}

function safeNotify(notify, event) {
  return Promise.resolve().then(() => notify?.(event)).catch(() => {});
}

// estimateGas/call revert with a raw ethers CALL_EXCEPTION (not a TransactionSafetyError) when the
// target contract doesn't actually implement the call being made -- the most common cause being a
// wrong or unsupported function signature. Without this, that exception was falling all the way
// through to a generic "request failed" response instead of a message that explains what happened.
function explainCallFailure(error, { chain, params } = {}) {
  // Insufficient funds is the most common simulation failure there is, and the least useful
  // one to pass through verbatim: "Simulating this call failed: insufficient funds" reads like
  // the contract rejected the mint, when what actually happened is that the wallet cannot pay
  // the network fee. It is especially confusing on a FREE drop, where the user can see the
  // price is 0 and reasonably concludes the app is broken. Say which wallet, on which chain,
  // and that gas is owed even when the mint itself is free.
  const insufficient = error?.code === 'INSUFFICIENT_FUNDS'
    || /insufficient funds/i.test(String(error?.shortMessage || error?.reason || error?.message || ''));
  if (insufficient) {
    const where = chain ? ` on ${chain}` : '';
    const who = params?.from ? ` (${params.from})` : '';
    return `This wallet cannot cover the mint price plus the network fee${where}${who}. `
      + "Both are paid from the same balance in that chain's own currency, and the node checks "
      + 'them together -- so this can mean the price is too high, the fee is, or only the two '
      + 'added up are. Nothing was broadcast and nothing was spent.';
  }
  // A bare provider.call() (no Contract/Interface attached, which is all this engine ever
  // does) never auto-decodes a custom Solidity error -- ethers can only surface the raw revert
  // bytes (error.data) for anyone who happens to know that contract's error ABI. SeaDrop is the
  // one protocol this app has that knowledge for (src/mint/seaDropErrors.js, sourced from
  // SeaDrop's real error definitions), so try it first; it's purely selector-based and simply
  // returns null for anything that isn't a recognized SeaDrop error, so trying it against a
  // non-SeaDrop failure is harmless.
  const seaDropReason = describeSeaDropError(error?.data);
  if (seaDropReason) return seaDropReason;
  // ethers synthesizes the literal reason "require(false)" whenever a revert returned zero
  // bytes of data (confirmed against the installed package's own AbiCoder.getBuiltinCallException)
  // -- reproduced live against a real reported failure (a contract with no mint(uint256) and no
  // fallback function). That zero-length signature is genuinely ambiguous between a real bare
  // require() with no message and calling a selector the contract doesn't implement at all, but
  // showing the raw "require(false)" text as if it were an informative reason is actively
  // misleading either way -- it reads like a real revert message when it is really "no
  // information was returned."
  if (error?.reason === 'require(false)' && (!error?.data || error.data === '0x')) {
    return 'Simulating this call failed with no reason given by the contract -- it may not implement the function this app tried to call, or a requirement failed silently (e.g. wrong price, quantity, or timing).';
  }
  if (error?.reason) return `Simulating this call failed: ${error.reason}`;
  if (error?.shortMessage) return `Simulating this call failed: ${error.shortMessage}`;
  if (error?.message) return `Simulating this call failed: ${error.message}`;
  return 'Simulating this call failed -- the contract may not implement this function, or the call would revert.';
}

function createTransactionEngine({
  providerService,
  // Round 15 (docs/WORKLIST.md Section AU): an optional, separately-configured provider service for
  // scheduled/Degen mints' pre-broadcast reads -- built from FAST_CHAINS (config/index.js), whose
  // per-chain {ENVNAME}_FAST_URLS is entirely opt-in and provider-agnostic, with the general pool's
  // own URLs appended as an automatic fallback. Left undefined, every fast-path call below just uses
  // `providerService` like before this existed -- this is purely additive.
  fastProviderService,
  // Round 16 (docs/WORKLIST.md Section AV): same idea, sniper's own pool -- built from SNIPER_CHAINS,
  // isolated from both the general pool and the scheduled/Degen fast pool so sniper's continuous
  // watching never shares a rate-limit bucket with a time-critical scheduled broadcast. Also the
  // service submit() races the broadcast itself across, via performAll() -- the one carve-out from
  // "broadcast always uses the conservative default," justified because it's the same signed
  // transaction to every candidate, so no double-spend risk exists the way there would be for any
  // other trigger source.
  sniperProviderService,
  intentRepository,
  policyRepository,
  decryptPrivateKey,
  nonceQueue = new WalletNonceQueue(),
  now = () => Date.now(),
  notify,
  pollIntervalMs = 1_000,
  feeDataCache = createFeeDataCache({ now }),
}) {
  async function providerCall(chain, name, operation, options, service = providerService) {
    return service.perform(chain, name, operation, options);
  }

  // Only consulted for scheduled and Degen-mode mints (see feeDataCache.js) -- every other caller
  // keeps getting a live quote. policy.gasPriceMultiplier is only ever non-1 for a preset with its
  // own multiplier (today, only Degen/"ultra_fast" -- see migration 035), so it doubles as the
  // "is this Degen" signal already resolved by this point, no new lookup needed.
  async function resolveFeeData(chain, useCache, options, service = providerService) {
    if (useCache) {
      const cached = feeDataCache.get(chain);
      if (cached) return cached;
    }
    const fresh = await providerCall(chain, 'getFeeData', provider => provider.getFeeData(), options, service);
    if (useCache) feeDataCache.set(chain, fresh);
    return fresh;
  }


  async function estimateGasSafely(chain, params, options, service = providerService) {
    try { return await providerCall(chain, 'estimateGas', provider => provider.estimateGas(params), options, service); }
    catch (error) { throw new TransactionSafetyError('SIMULATION_FAILED', explainCallFailure(error, { chain, params })); }
  }

  async function simulateCallSafely(chain, params, options, service = providerService) {
    try { return await providerCall(chain, 'simulate', provider => provider.call(params), options, service); }
    catch (error) { throw new TransactionSafetyError('SIMULATION_FAILED', explainCallFailure(error, { chain, params })); }
  }

  async function transition(intentId, state, details) {
    const updated = await intentRepository.transition(intentId, state, details);
    await safeNotify(notify, { intent: updated, state });
    return updated;
  }

  async function inspectChain(intent) {
    if (!intent.txHash) return { state: 'unknown', reason: 'signed transaction hash was not persisted' };
    const receipt = await providerCall(intent.chain, 'getTransactionReceipt', provider => provider.getTransactionReceipt(intent.txHash));
    if (receipt) {
      const gasUsed=receipt.gasUsed===undefined?null:BigInt(receipt.gasUsed);
      const effectiveGasPriceWei=receipt.gasPrice===undefined||receipt.gasPrice===null
        ? (receipt.effectiveGasPrice===undefined||receipt.effectiveGasPrice===null?null:BigInt(receipt.effectiveGasPrice)):BigInt(receipt.gasPrice);
      const actualNetworkCostWei=gasUsed!==null&&effectiveGasPriceWei!==null?gasUsed*effectiveGasPriceWei:null;
      const receiptCost={gasUsed,effectiveGasPriceWei,actualNetworkCostWei};
      if (Number(receipt.status) === 0) return { state: 'reverted', blockNumber: Number(receipt.blockNumber), reason: 'transaction reverted on chain',...receiptCost };
      // Section T: which token ID(s) this mint actually received, read from the NFT contract's own
      // Transfer/TransferSingle/TransferBatch event(s) -- never the transaction's own `to`, which
      // for a SeaDrop mint is the SeaDrop core, not the token contract. Computed once here (logs
      // don't change with more confirmations) and carried the same way receiptCost already is.
      const tokenIds = extractMintedTokenIds(receipt, { contractAddress: intent.callPreview?.contractAddress, minterAddress: intent.from });
      const currentBlock = await providerCall(intent.chain, 'getBlockNumber', provider => provider.getBlockNumber());
      const confirmations = Math.max(0, Number(currentBlock) - Number(receipt.blockNumber) + 1);
      if (confirmations >= intent.requiredConfirmations) {
        return { state: 'confirmed', blockNumber: Number(receipt.blockNumber), reason: `${confirmations} confirmations observed`,...receiptCost, tokenIds };
      }
      return { state: 'pending', blockNumber: Number(receipt.blockNumber), reason: `${confirmations}/${intent.requiredConfirmations} confirmations observed`,...receiptCost };
    }
    const transaction = await providerCall(intent.chain, 'getTransaction', provider => provider.getTransaction(intent.txHash));
    if (transaction) return { state: 'pending', reason: 'transaction is present in the provider mempool' };
    const pendingNonce = await providerCall(intent.chain, 'getTransactionCount', provider => provider.getTransactionCount(intent.from, 'pending'));
    if (Number(pendingNonce) > intent.nonce) return { state: 'replaced', reason: 'wallet nonce was consumed by another transaction' };
    if (now() >= intent.timeoutAt) return { state: 'unknown', reason: 'transaction timed out without a chain receipt' };
    return { state: intent.state === 'unknown' ? 'unknown' : 'submitted', reason: 'transaction is not yet visible on chain' };
  }

  async function reconcileIntent(intent) {
    if (FINAL_STATES.has(intent.state)) return intent;
    const observed = await inspectChain(intent);
    return transition(intent.intentId, observed.state, observed);
  }

  async function preview(request) {
    const policy=await policyRepository.resolvePolicy({userId:request.userId,walletId:request.wallet.id,
      targetId:request.targetId,chain:request.chain,triggerSource:request.triggerSource||'manual'});
    const valueWei=asBigInt(request.valueWei??0n,'valueWei');
    if(valueWei<0n) throw new TransactionSafetyError('INVALID_TRANSACTION','Transaction value cannot be negative');
    if(!policy.ceilingExempt&&valueWei>policy.maxTransactionValueWei) throw new TransactionSafetyError('VALUE_CEILING_EXCEEDED','Transaction value exceeds the configured maximum');
    const base={from:request.wallet.address,to:request.to,data:request.data||'0x',value:valueWei};
    const feeData=await providerCall(request.chain,'getFeeData',provider=>provider.getFeeData());
    const explicit=request.gasPriceWei!==undefined&&request.gasPriceWei!==null;
    const gasPriceWei=explicit?asBigInt(request.gasPriceWei,'gasPriceWei'):(feeData.maxFeePerGas?null:applyGasMultiplier(feeData.gasPrice,policy.gasPriceMultiplier));
    const maxFeePerGasWei=explicit?null:applyGasMultiplier(feeData.maxFeePerGas,policy.gasPriceMultiplier);
    const maxPriorityFeePerGasWei=explicit?null:applyGasMultiplier(feeData.maxPriorityFeePerGas,policy.gasPriceMultiplier);
    const selectedFee=maxFeePerGasWei??gasPriceWei;
    if(selectedFee===null||selectedFee===undefined) throw new TransactionSafetyError('FEE_UNAVAILABLE','RPC provider did not return usable fee data');
    if(!policy.ceilingExempt&&selectedFee>parseUnits(String(policy.gasCeilingGwei),'gwei')) throw new TransactionSafetyError('GAS_CEILING_EXCEEDED','Transaction fee exceeds the configured gas ceiling');
    const feeFields=maxFeePerGasWei!==null&&maxFeePerGasWei!==undefined
      ?{maxFeePerGas:maxFeePerGasWei,maxPriorityFeePerGas:maxPriorityFeePerGasWei??0n,type:2}:{gasPrice:gasPriceWei};
    const gasLimit=await estimateGasSafely(request.chain,{...base,...feeFields});
    const estimatedCostWei=valueWei+BigInt(gasLimit)*BigInt(selectedFee);
    const balance=await providerCall(request.chain,'getBalance',provider=>provider.getBalance(request.wallet.address));
    if(BigInt(balance)<estimatedCostWei) throw new TransactionSafetyError('INSUFFICIENT_BALANCE','Wallet balance is below the estimated transaction cost');
    const spent=await intentRepository.rollingSpendWei(request.userId,request.wallet.id,now()-86_400_000);
    if(!policy.ceilingExempt&&spent+estimatedCostWei>policy.dailySpendingBudgetWei) throw new TransactionSafetyError('DAILY_BUDGET_EXCEEDED','Transaction would exceed the wallet daily spending budget');
    const simulationPerformed=policy.simulationEnabled||request.forceSimulation===true;
    if(simulationPerformed) await simulateCallSafely(request.chain,{...base,...feeFields,gasLimit});
    return {simulationEnabled:policy.simulationEnabled,simulationPerformed,simulationPassed:true,gasLimit:BigInt(gasLimit),
      estimatedCostWei,feePerGasWei:BigInt(selectedFee)};
  }

  async function waitForFinality(intent) {
    let current = intent;
    while (!FINAL_STATES.has(current.state) && now() < current.timeoutAt) {
      current = await reconcileIntent(current);
      if (!FINAL_STATES.has(current.state)) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }
    if (!FINAL_STATES.has(current.state)) {
      current = await transition(current.intentId, 'unknown', { reason: 'transaction confirmation timeout elapsed' });
    }
    return current;
  }

  async function submit(request) {
    const walletKey = `${request.chain}:${request.wallet.id}`;
    // Round 16 (Section AV): "keep the launch path minimal, add end-to-end timing logs" -- these
    // four checkpoints are the only new work on the hot path, purely additive (no branching, no new
    // awaits). Reported via one extra notify() call after broadcast, not persisted through
    // intentRepository at all, so this can never affect what actually gets stored for an intent --
    // whoever's listening on notify (server.js today) decides whether/how to log or aggregate it,
    // and confirmedAt is already available for free from the existing state:'confirmed' notify
    // reconcileIntent already fires, no new instrumentation needed for that half.
    const timings = { submitStartedAt: now() };
    let finalityPromise;
    const queuedResult = await nonceQueue.run(walletKey, async () => {
      if (request.idempotencyKey && intentRepository.getByIdempotencyKey) {
        const existing = await intentRepository.getByIdempotencyKey(request.idempotencyKey);
        if (existing) return existing;
      }
      const policy = await policyRepository.resolvePolicy({
        userId: request.userId,
        walletId: request.wallet.id,
        targetId: request.targetId,
        chain: request.chain,
        triggerSource: request.triggerSource || 'manual',
      });
      const valueWei = asBigInt(request.valueWei ?? 0n, 'valueWei');
      if (valueWei < 0n) throw new TransactionSafetyError('INVALID_TRANSACTION', 'Transaction value cannot be negative');
      if (!policy.ceilingExempt && valueWei > policy.maxTransactionValueWei) {
        throw new TransactionSafetyError('VALUE_CEILING_EXCEEDED', 'Transaction value exceeds the configured maximum');
      }

      const from = request.wallet.address;
      const base = { from, to: request.to, data: request.data || '0x', value: valueWei };
      // Scheduled mints, Degen-mode mints (policy.gasPriceMultiplier > 1 -- see feeDataCache.js's
      // own note), sniper fires (triggerSource === 'blockchain' -- Round 16, Section AV: sniper
      // is its own execution profile, not gated on the mode preset at all), and launch-squad sends
      // (triggerSource === 'launch' -- src/launch: a coordinated burst is exactly as time-critical
      // as a scheduled fire, and its staging phase already did every slow check) all get a tighter
      // per-call RPC budget on every pre-broadcast read below: a slow primary RPC is abandoned after
      // one fast attempt instead of eating the full default timeout across every retry before even
      // trying the next configured URL. Sniper additionally gets its own isolated pool
      // (sniperProviderService) rather than sharing the scheduled/Degen fast pool -- continuous
      // sniper watching must never be able to queue behind a time-critical scheduled broadcast, the
      // whole reason these pools were split in the first place.
      const isSniperTrigger = request.triggerSource === 'blockchain';
      const trigger = request.triggerSource || 'manual';
      const useFastPath = isSniperTrigger || trigger === 'scheduled' || trigger === 'launch' || policy.gasPriceMultiplier > 1;
      const fastRpcOptions = useFastPath ? { timeoutMs: FAST_RPC_TIMEOUT_MS, retries: FAST_RPC_RETRIES } : undefined;
      const activeService = isSniperTrigger && sniperProviderService ? sniperProviderService
        : (useFastPath && fastProviderService ? fastProviderService : providerService);
      // Hot-path batching: policy has to land first because it selects the pool and the per-call
      // timeout budget used by every RPC below, but after that the three independent reads -- fee
      // data, wallet balance, rolling daily spend -- were awaited strictly one after another even
      // though nothing links them. They leave together now; every validation further down keeps its
      // original order and operands, so only wall-clock latency changes, never which error surfaces.
      const [feeData, balance, spent] = await Promise.all([
        resolveFeeData(request.chain, useFastPath, fastRpcOptions, activeService),
        providerCall(request.chain, 'getBalance', provider => provider.getBalance(from), fastRpcOptions, activeService),
        intentRepository.rollingSpendWei(request.userId, request.wallet.id, now() - 86_400_000),
      ]);
      const hasExplicitLegacyFee = request.gasPriceWei !== undefined && request.gasPriceWei !== null;
      const hasExplicitMaxFee = request.maxFeePerGasWei !== undefined && request.maxFeePerGasWei !== null;
      const gasPriceWei = hasExplicitLegacyFee
        ? asBigInt(request.gasPriceWei, 'gasPriceWei')
        : (hasExplicitMaxFee || feeData.maxFeePerGas ? null : applyGasMultiplier(feeData.gasPrice, policy.gasPriceMultiplier));
      const maxFeePerGasWei = hasExplicitLegacyFee
        ? null
        : (hasExplicitMaxFee ? asBigInt(request.maxFeePerGasWei, 'maxFeePerGasWei') : applyGasMultiplier(feeData.maxFeePerGas, policy.gasPriceMultiplier));
      const maxPriorityFeePerGasWei = hasExplicitLegacyFee
        ? null
        : (request.maxPriorityFeePerGasWei !== undefined && request.maxPriorityFeePerGasWei !== null
          ? asBigInt(request.maxPriorityFeePerGasWei, 'maxPriorityFeePerGasWei')
          : applyGasMultiplier(feeData.maxPriorityFeePerGas, policy.gasPriceMultiplier));
      const selectedFee = maxFeePerGasWei ?? gasPriceWei;
      if (selectedFee === null || selectedFee === undefined) {
        throw new TransactionSafetyError('FEE_UNAVAILABLE', 'RPC provider did not return usable fee data');
      }
      if (selectedFee < 0n || (maxPriorityFeePerGasWei !== null && maxPriorityFeePerGasWei !== undefined && maxPriorityFeePerGasWei < 0n)) {
        throw new TransactionSafetyError('INVALID_TRANSACTION', 'Transaction fees cannot be negative');
      }
      if (maxFeePerGasWei !== null && maxFeePerGasWei !== undefined
        && maxPriorityFeePerGasWei !== null && maxPriorityFeePerGasWei !== undefined
        && maxPriorityFeePerGasWei > maxFeePerGasWei) {
        throw new TransactionSafetyError('INVALID_TRANSACTION', 'Priority fee cannot exceed the maximum fee');
      }
      const gasCeilingWei = parseUnits(String(policy.gasCeilingGwei), 'gwei');
      if (!policy.ceilingExempt && selectedFee > gasCeilingWei) {
        throw new TransactionSafetyError('GAS_CEILING_EXCEEDED', 'Transaction fee exceeds the configured gas ceiling');
      }
      // A per-request tolerance (the guided batch-mint flow's gas-tolerance step) rather than a
      // governance-imposed cap -- applies even when the caller is ceilingExempt, since choosing it
      // was the caller's own decision for this specific batch, not something governance enforces.
      if (request.maxGasGwei !== undefined && request.maxGasGwei !== null) {
        const toleranceWei = parseUnits(String(request.maxGasGwei), 'gwei');
        if (selectedFee > toleranceWei) {
          throw new TransactionSafetyError('GAS_TOLERANCE_EXCEEDED', 'Transaction fee exceeds the gas tolerance set for this batch');
        }
      }

      const feeFields = maxFeePerGasWei !== null && maxFeePerGasWei !== undefined
        ? { maxFeePerGas: maxFeePerGasWei, maxPriorityFeePerGas: maxPriorityFeePerGasWei ?? 0n, type: 2 }
        : { gasPrice: gasPriceWei };
      const gasLimit = request.gasLimitWei === undefined
        ? await estimateGasSafely(request.chain, { ...base, ...feeFields }, fastRpcOptions, activeService)
        : asBigInt(request.gasLimitWei, 'gasLimitWei');
      if (gasLimit <= 0n) throw new TransactionSafetyError('INVALID_TRANSACTION', 'Gas limit must be positive');
      const estimatedCostWei = valueWei + gasLimit * selectedFee;
      if (BigInt(balance) < estimatedCostWei) {
        throw new TransactionSafetyError('INSUFFICIENT_BALANCE', 'Wallet balance is below the estimated transaction cost');
      }
      if (!policy.ceilingExempt && spent + estimatedCostWei > policy.dailySpendingBudgetWei) {
        throw new TransactionSafetyError('DAILY_BUDGET_EXCEEDED', 'Transaction would exceed the wallet daily spending budget');
      }
      if (policy.simulationEnabled) {
        await simulateCallSafely(request.chain, { ...base, ...feeFields, gasLimit }, fastRpcOptions, activeService);
      }

      // Same batching one step later: the pending-nonce read and the chain-identity check share no
      // dependency either -- the network answer only feeds the WRONG_CHAIN guard and the signed
      // transaction's own chainId -- and both were serial legs between simulation and signing.
      const [pendingNonceRaw, network] = await Promise.all([
        providerCall(request.chain, 'getTransactionCount', provider => provider.getTransactionCount(from, 'pending'), fastRpcOptions, activeService),
        providerCall(request.chain, 'getNetwork', provider => provider.getNetwork(), fastRpcOptions, activeService),
      ]);
      const providerNonce = Number(pendingNonceRaw);
      const expectedChainId = providerService.expectedChainId?.(request.chain);
      if (expectedChainId !== null && expectedChainId !== undefined && BigInt(network.chainId) !== BigInt(expectedChainId)) {
        throw new TransactionSafetyError('WRONG_CHAIN', 'RPC provider is connected to the wrong chain');
      }
      const signer = new Wallet(decryptPrivateKey(request.wallet));
      if (signer.address.toLowerCase() !== from.toLowerCase()) {
        throw new TransactionSafetyError('WALLET_KEY_MISMATCH', 'Stored private key does not match the wallet address');
      }
      let nonce;
      let intent;
      for (let attempt = 0; attempt < 5 && !intent; attempt += 1) {
        nonce = intentRepository.nextNonce
          ? await intentRepository.nextNonce({ chain: request.chain, from, providerNonce })
          : providerNonce;
        try {
          intent = await intentRepository.createSubmitted({
            userId: request.userId,
            walletId: request.wallet.id,
            targetId: request.targetId || null,
            chain: request.chain,
            from,
            to: request.to,
            data: request.data || '0x',
            valueWei,
            nonce,
            gasLimit,
            gasPriceWei,
            maxFeePerGasWei,
            maxPriorityFeePerGasWei,
            estimatedCostWei,
            simulationEnabled: policy.simulationEnabled,
            requiredConfirmations: policy.requiredConfirmations,
            transactionTimeoutMs: policy.transactionTimeoutMs,
            timeoutAt: now() + policy.transactionTimeoutMs,
            methodSignature: request.methodSignature || null,
            callPreview: request.callPreview || null,
            idempotencyKey: request.idempotencyKey || null,
            // The bump ladder scopes its candidates by this column -- without it every intent
            // would read 'manual' and launch/scheduled re-bids would never find their targets.
            triggerSource: trigger,
          });
        } catch (error) {
          if (error?.code !== '23505') throw error;
          if (request.idempotencyKey && intentRepository.getByIdempotencyKey) {
            const existing = await intentRepository.getByIdempotencyKey(request.idempotencyKey);
            if (existing) return existing;
          }
        }
      }
      if (!intent) throw new TransactionSafetyError('NONCE_RESERVATION_FAILED', 'Could not reserve a unique wallet nonce');
      if (request.onIntentPersisted) await request.onIntentPersisted(intent);
      timings.preparedAt = now();
      const transaction = {
        to: request.to,
        data: request.data || '0x',
        value: valueWei,
        nonce,
        gasLimit,
        chainId: BigInt(network.chainId),
        ...feeFields,
      };

      const signedTransaction = await signer.signTransaction(transaction);
      timings.signedAt = now();
      const txHash = keccak256(signedTransaction);
      intent = await intentRepository.attachSignedHash(intent.intentId, txHash);
      try {
        // Round 16 (Section AV): sniper races the same signed transaction across every candidate
        // in its own pool concurrently instead of trying one at a time -- safe because it's the
        // same nonce+signature everywhere, so a losing endpoint's own response (often just
        // "already known") is harmless to discard. Every other trigger source keeps the
        // conservative sequential default; a failed/slow broadcast is too costly to get wrong to
        // race it without a reason as strong as sniper's actual competitive-inclusion use case.
        if (isSniperTrigger && sniperProviderService) {
          await sniperProviderService.performAll(request.chain, 'broadcastTransaction', provider => provider.broadcastTransaction(signedTransaction));
        } else if (trigger === 'launch') {
          // Launch squads race too (Round 22, day 4): a coordinated burst is the exact competitive
          // use case sniper's race was built for -- same nonce+signature everywhere, losing
          // endpoints' "already known" responses are harmless -- and its staging phase did all the
          // slow verification up front, so there is no sequential-fallback safety argument left.
          const racing = useFastPath && fastProviderService ? fastProviderService : providerService;
          await racing.performAll(request.chain, 'broadcastTransaction', provider => provider.broadcastTransaction(signedTransaction));
        } else {
          await providerCall(request.chain, 'broadcastTransaction', provider => provider.broadcastTransaction(signedTransaction));
        }
      } catch (error) {
        await transition(intent.intentId, 'unknown', { reason: 'broadcast result was not observable' });
        throw new TransactionSafetyError('BROADCAST_UNKNOWN', 'Transaction broadcast outcome is unknown; reconciliation will continue');
      }
      timings.broadcastAt = now();
      await safeNotify(notify, { intent, event: 'timing', triggerSource: request.triggerSource || 'manual', chain: request.chain, timings });
      intent = await transition(intent.intentId, 'pending', { reason: 'raw signed transaction broadcast accepted' });
      // Finality tracking starts here but is deliberately NOT awaited inside this callback: the
      // wallet queue releases the moment the callback resolves, and previously it stayed locked
      // through every confirmation poll -- up to the full transaction timeout on slow-finality
      // chains -- so a rapid-fire second mint from the same wallet couldn't even begin its
      // pre-broadcast reads until the first was fully final. Overlapping submissions are safe
      // without that lock: the next one's nonce comes from nextNonce()'s GREATEST(provider
      // pending count, MAX(persisted nonce)+1), backed by the unique-constraint retry loop, so a
      // provider read that lags behind an in-flight transaction can never reissue its nonce.
      // Callers still receive the final-state intent exactly as before (submit() awaits the
      // tracking promise outside the queue); only the lock-hold time shrinks.
      finalityPromise = waitForFinality(intent);
      return intent;
    });
    return finalityPromise ?? queuedResult;
  }

  async function reconcileNonFinal() {
    const intents = await intentRepository.listNonFinal();
    const results = [];
    for (const intent of intents) {
      try { results.push(await reconcileIntent(intent)); }
      catch (error) {
        // A failure here (e.g. an RPC outage during the boot-time reconciliation sweep) used to be
        // swallowed with no trace: the intent still counted toward reconcileNonFinal's returned
        // length, making a stuck/errored intent indistinguishable from a successfully-reconciled one
        // in the "Reconciled N non-final transaction intents" startup log. This is the engine's only
        // outward signal (it has no log dependency of its own), so a failed reconciliation is at
        // least observable to whatever the caller wires notify to.
        await safeNotify(notify, { intent, state: 'reconcile_failed', error: error?.message });
        results.push(intent);
      }
    }
    return results;
  }

  return { preview,reconcileIntent, reconcileNonFinal, submit, waitForFinality };
}

module.exports = { FINAL_STATES, TransactionSafetyError, createTransactionEngine, explainCallFailure };
