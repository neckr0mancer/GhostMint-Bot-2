const { Wallet, keccak256, parseUnits } = require('ethers');
const { WalletNonceQueue } = require('./nonceQueue');

const FINAL_STATES = new Set(['confirmed', 'reverted', 'replaced']);

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

function safeNotify(notify, event) {
  return Promise.resolve().then(() => notify?.(event)).catch(() => {});
}

function createTransactionEngine({
  providerService,
  intentRepository,
  policyRepository,
  decryptPrivateKey,
  nonceQueue = new WalletNonceQueue(),
  now = () => Date.now(),
  notify,
  pollIntervalMs = 1_000,
}) {
  async function providerCall(chain, name, operation) {
    return providerService.perform(chain, name, operation);
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
      const currentBlock = await providerCall(intent.chain, 'getBlockNumber', provider => provider.getBlockNumber());
      const confirmations = Math.max(0, Number(currentBlock) - Number(receipt.blockNumber) + 1);
      if (confirmations >= intent.requiredConfirmations) {
        return { state: 'confirmed', blockNumber: Number(receipt.blockNumber), reason: `${confirmations} confirmations observed`,...receiptCost };
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
    const gasPriceWei=explicit?asBigInt(request.gasPriceWei,'gasPriceWei'):(feeData.maxFeePerGas?null:feeData.gasPrice);
    const maxFeePerGasWei=explicit?null:feeData.maxFeePerGas;
    const maxPriorityFeePerGasWei=explicit?null:feeData.maxPriorityFeePerGas;
    const selectedFee=maxFeePerGasWei??gasPriceWei;
    if(selectedFee===null||selectedFee===undefined) throw new TransactionSafetyError('FEE_UNAVAILABLE','RPC provider did not return usable fee data');
    if(!policy.ceilingExempt&&selectedFee>parseUnits(String(policy.gasCeilingGwei),'gwei')) throw new TransactionSafetyError('GAS_CEILING_EXCEEDED','Transaction fee exceeds the configured gas ceiling');
    const feeFields=maxFeePerGasWei!==null&&maxFeePerGasWei!==undefined
      ?{maxFeePerGas:maxFeePerGasWei,maxPriorityFeePerGas:maxPriorityFeePerGasWei??0n,type:2}:{gasPrice:gasPriceWei};
    const gasLimit=await providerCall(request.chain,'estimateGas',provider=>provider.estimateGas({...base,...feeFields}));
    const estimatedCostWei=valueWei+BigInt(gasLimit)*BigInt(selectedFee);
    const balance=await providerCall(request.chain,'getBalance',provider=>provider.getBalance(request.wallet.address));
    if(BigInt(balance)<estimatedCostWei) throw new TransactionSafetyError('INSUFFICIENT_BALANCE','Wallet balance is below the estimated transaction cost');
    const spent=await intentRepository.rollingSpendWei(request.userId,request.wallet.id,now()-86_400_000);
    if(!policy.ceilingExempt&&spent+estimatedCostWei>policy.dailySpendingBudgetWei) throw new TransactionSafetyError('DAILY_BUDGET_EXCEEDED','Transaction would exceed the wallet daily spending budget');
    const simulationPerformed=policy.simulationEnabled||request.forceSimulation===true;
    if(simulationPerformed) await providerCall(request.chain,'simulate',provider=>provider.call({...base,...feeFields,gasLimit}));
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
    return nonceQueue.run(walletKey, async () => {
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
      const feeData = await providerCall(request.chain, 'getFeeData', provider => provider.getFeeData());
      const hasExplicitLegacyFee = request.gasPriceWei !== undefined && request.gasPriceWei !== null;
      const hasExplicitMaxFee = request.maxFeePerGasWei !== undefined && request.maxFeePerGasWei !== null;
      const gasPriceWei = hasExplicitLegacyFee
        ? asBigInt(request.gasPriceWei, 'gasPriceWei')
        : (hasExplicitMaxFee || feeData.maxFeePerGas ? null : feeData.gasPrice);
      const maxFeePerGasWei = hasExplicitLegacyFee
        ? null
        : (hasExplicitMaxFee ? asBigInt(request.maxFeePerGasWei, 'maxFeePerGasWei') : feeData.maxFeePerGas);
      const maxPriorityFeePerGasWei = hasExplicitLegacyFee
        ? null
        : (request.maxPriorityFeePerGasWei !== undefined && request.maxPriorityFeePerGasWei !== null
          ? asBigInt(request.maxPriorityFeePerGasWei, 'maxPriorityFeePerGasWei')
          : feeData.maxPriorityFeePerGas);
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

      const feeFields = maxFeePerGasWei !== null && maxFeePerGasWei !== undefined
        ? { maxFeePerGas: maxFeePerGasWei, maxPriorityFeePerGas: maxPriorityFeePerGasWei ?? 0n, type: 2 }
        : { gasPrice: gasPriceWei };
      const gasLimit = request.gasLimitWei === undefined
        ? await providerCall(request.chain, 'estimateGas', provider => provider.estimateGas({ ...base, ...feeFields }))
        : asBigInt(request.gasLimitWei, 'gasLimitWei');
      if (gasLimit <= 0n) throw new TransactionSafetyError('INVALID_TRANSACTION', 'Gas limit must be positive');
      const estimatedCostWei = valueWei + gasLimit * selectedFee;
      const balance = await providerCall(request.chain, 'getBalance', provider => provider.getBalance(from));
      if (BigInt(balance) < estimatedCostWei) {
        throw new TransactionSafetyError('INSUFFICIENT_BALANCE', 'Wallet balance is below the estimated transaction cost');
      }
      const spent = await intentRepository.rollingSpendWei(request.userId, request.wallet.id, now() - 86_400_000);
      if (!policy.ceilingExempt && spent + estimatedCostWei > policy.dailySpendingBudgetWei) {
        throw new TransactionSafetyError('DAILY_BUDGET_EXCEEDED', 'Transaction would exceed the wallet daily spending budget');
      }
      if (policy.simulationEnabled) {
        await providerCall(request.chain, 'simulate', provider => provider.call({ ...base, ...feeFields, gasLimit }));
      }

      const providerNonce = Number(await providerCall(request.chain, 'getTransactionCount', provider => provider.getTransactionCount(from, 'pending')));
      const network = await providerCall(request.chain, 'getNetwork', provider => provider.getNetwork());
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
      const txHash = keccak256(signedTransaction);
      intent = await intentRepository.attachSignedHash(intent.intentId, txHash);
      try {
        await providerCall(request.chain, 'broadcastTransaction', provider => provider.broadcastTransaction(signedTransaction));
      } catch (error) {
        await transition(intent.intentId, 'unknown', { reason: 'broadcast result was not observable' });
        throw new TransactionSafetyError('BROADCAST_UNKNOWN', 'Transaction broadcast outcome is unknown; reconciliation will continue');
      }
      intent = await transition(intent.intentId, 'pending', { reason: 'raw signed transaction broadcast accepted' });
      return waitForFinality(intent);
    });
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

module.exports = { FINAL_STATES, TransactionSafetyError, createTransactionEngine };
