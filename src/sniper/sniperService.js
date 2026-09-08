const { parseEther, parseUnits } = require('ethers');
const { ValidationError, requestSchemas } = require('../validation/domain');
const { formatCopyMintPreview, prepareCopyMintCall } = require('../mint/copyMintCall');

const TRANSIENT_CODES = new Set(['RPC_UNAVAILABLE','BROADCAST_UNKNOWN','NETWORK_ERROR','SERVER_ERROR','TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN']);
const lower = value => String(value || '').toLowerCase();

function createSniperService({ repository, intentRepository, transactionEngine, supportedChains, now = () => Date.now(),
  onEvent = async () => {}, beforeExecute = async () => true }) {
  function validateCreate(input) { return requestSchemas.sniperCreate(input, { supportedChains }); }
  function validatePatch(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError({ field:'patch', message:'must be an object' });
    const allowed = new Set(['label','targetAddress','chain','walletLabel','valueMode','fixedValueETH','maxValueETH',
      'gasBoostPercent','maxGasGwei','dailySpendingCapETH','cooldownMs','maxAttempts','contractAllowlist',
      'contractDenylist','sourceConfirmations','observationMode','active']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new ValidationError({ field:key, message:'cannot be patched' });
    if (patch.active !== undefined && typeof patch.active !== 'boolean') throw new ValidationError({ field:'active', message:'must be a boolean' });
    return { ...current, ...validateCreate({ ...current, ...patch }), active:patch.active === undefined ? current.active : patch.active };
  }

  async function emitEvent(payload) {
    // Chain/database state is authoritative. A Telegram, Discord, dashboard, or activity callback
    // failure must never rewrite a confirmed transaction as failed or make a safe skip retry.
    try { await onEvent(payload); } catch { /* delivery/reporting is deliberately best-effort */ }
  }

  async function skip(event, reason) {
    const skipped = await repository.transition(event, 'skipped', {
      skipReason:reason, expectedStates:['detected'],
    });
    if (!skipped) return 'duplicate';
    await emitEvent({ event:skipped, state:'skipped', reason });
    return 'skipped';
  }

  async function execute(sniper, event, sourceTx, wallet, getReceipt = hash => sourceTx.provider.getTransactionReceipt(hash)) {
    const observationMode = event.observationMode || sniper.observationMode || 'confirmed';
    // Confirmed-copy must prove the observed source transaction is still canonical. Pending-copy
    // deliberately acts before such a receipt can exist: the owner explicitly opted into the risk
    // that the source may later be dropped, replaced, or reverted while this copy still spends.
    if (observationMode !== 'pending') {
      const canonical = await getReceipt(event.txHash);
      if (!canonical || canonical.blockHash !== event.sourceBlockHash || canonical.status !== 1) {
        return skip(event, 'source transaction was dropped or changed by a chain reorganization');
      }
    }
    let prepared;
    try {
      prepared = prepareCopyMintCall({ callTarget:sourceTx.to, data:sourceTx.data || sourceTx.input,
        valueWei:sourceTx.value ?? 0n, walletAddress:wallet.address });
    } catch (error) {
      const reason = error instanceof ValidationError
        ? `unsafe or unsupported source call: ${error.message}`
        : 'unsafe or unsupported source call';
      return skip(event, reason.slice(0, 500));
    }
    const contract = lower(prepared.contractAddress);
    if (sniper.contractDenylist.map(lower).includes(contract)) return skip(event, 'contract is denylisted');
    if (sniper.contractAllowlist.length && !sniper.contractAllowlist.map(lower).includes(contract)) return skip(event, 'contract is not allowlisted');
    if (sniper.lastFiredAt && now() - sniper.lastFiredAt < sniper.cooldownMs) return skip(event, 'sniper cooldown is active');

    let value = prepared.valueWei;
    if (sniper.valueMode === 'fixed') value = parseEther(String(sniper.fixedValueETH));
    if (value > parseEther(String(sniper.maxValueETH))) return skip(event, 'maximum copied value exceeded');
    if (value !== prepared.valueWei) {
      prepared = { ...prepared, valueWei:value, preview:formatCopyMintPreview({
        ...prepared.preview, nativeValueWei:value, nativeValue:undefined,
      }) };
    }
    const boost = BigInt(100 + sniper.gasBoostPercent);
    const sourceFeeValue = sourceTx.maxFeePerGas ?? sourceTx.gasPrice;
    const sourceGasLimitValue = sourceTx.gasLimit ?? sourceTx.gas;
    if (sourceFeeValue === null || sourceFeeValue === undefined
      || sourceGasLimitValue === null || sourceGasLimitValue === undefined
      || BigInt(sourceFeeValue) <= 0n || BigInt(sourceGasLimitValue) <= 0n) {
      return skip(event, 'source transaction fee details are unavailable');
    }
    const sourceFee = BigInt(sourceFeeValue);
    const sourceGasLimit = BigInt(sourceGasLimitValue);
    const copiedFee = sourceFee * boost / 100n;
    if (copiedFee > parseUnits(String(sniper.maxGasGwei), 'gwei')) return skip(event, 'maximum gas price exceeded');
    const reservedNetworkCostWei = sourceGasLimit * copiedFee;
    const dailyCapWei = parseEther(String(sniper.dailySpendingCapETH));
    const spent = await repository.dailySpendWei(sniper.userId, sniper.id, now() - 86_400_000);
    if (spent + value + reservedNetworkCostWei > dailyCapWei) return skip(event, 'daily sniper spending cap exceeded');
    if (!await beforeExecute({ sniper, event, sourceTx, wallet, value, copiedFee, prepared })) {
      return skip(event, 'waiting for explicit trigger confirmation');
    }
    const claimResult = await repository.claim(event, { maxAttempts:sniper.maxAttempts, nowMs:now(),
      cooldownMs:sniper.cooldownMs, dailyCapWei, copiedValueWei:value, reservedNetworkCostWei });
    if (claimResult?.terminal) return skip(event, claimResult.reason);
    const claimed = claimResult && Object.prototype.hasOwnProperty.call(claimResult, 'event')
      ? claimResult.event : claimResult;
    if (!claimed) return 'duplicate';
    try {
      const intent = await transactionEngine.submit({ userId:sniper.userId, wallet, targetId:sniper.id,
        chain:sniper.chain, triggerSource:'blockchain', to:prepared.callTarget, data:prepared.calldata, valueWei:value,
        gasPriceWei:sourceTx.maxFeePerGas ? undefined : copiedFee,
        maxFeePerGasWei:sourceTx.maxFeePerGas ? copiedFee : undefined,
        maxPriorityFeePerGasWei:sourceTx.maxFeePerGas
          ? (sourceTx.maxPriorityFeePerGas || sourceTx.maxFeePerGas) * boost / 100n : undefined,
        methodSignature:prepared.methodSignature, callPreview:prepared.preview,
        idempotencyKey:`sniper:${sniper.userId}:${sniper.id}:${event.txHash}:attempt:${claimed.attemptCount}`,
        onIntentPersisted:intent => repository.attachIntent
          ? repository.attachIntent(claimed,intent.intentId,value)
          : repository.transition(claimed,'submitted',{intentId:intent.intentId,valueWei:value}) });
      const nextState = intent.state === 'confirmed' ? 'confirmed' : 'submitted';
      const transitioned = await repository.transition(claimed, nextState,
        { intentId:intent.intentId, valueWei:value, expectedStates:['submitted'] });
      if (transitioned) await emitEvent({ event:transitioned, state:nextState, intent });
      return transitioned ? nextState : 'duplicate';
    } catch (error) {
      const retryable = TRANSIENT_CODES.has(error?.code);
      const failed = await repository.transition(claimed, 'failed', {
        failureReason:String(error?.message || 'copy failed').slice(0,500), retryable,
        expectedStates:['submitted'],
      });
      if (!failed) return 'duplicate';
      await emitEvent({ event:failed, state:'failed', error });
      if (retryable && claimed.attemptCount < sniper.maxAttempts) await repository.requeueRetryable(failed, sniper.maxAttempts);
      return 'failed';
    }
  }

  async function detect(sniper, tx) {
    return repository.detect(sniper, tx);
  }

  async function processPending(sniper, event, sourceTx, wallet) {
    if (!wallet) return skip(event, 'firing wallet was not found');
    return execute(sniper, event, sourceTx, wallet);
  }

  async function processBlock(chain, blockNumber, snipers, getTransaction, getReceipt, walletFor) {
    if (intentRepository) {
      const submitted = await repository.listSubmitted(chain);
      await Promise.allSettled(submitted.map(async event => {
        let intent = event.transactionIntentId ? await intentRepository.get(event.transactionIntentId) : null;
        if (!intent) intent = await intentRepository.getByIdempotencyKey(
          `sniper:${event.userId}:${event.sniperId}:${event.txHash}:attempt:${event.attemptCount}`);
        // Backward compatibility for events claimed by the pre-attempt-key implementation.
        if (!intent) intent = await intentRepository.getByIdempotencyKey(
          `sniper:${event.userId}:${event.sniperId}:${event.txHash}`);
        if (!intent) {
          const failed = await repository.transition(event,'failed',{
            failureReason:'interrupted before transaction intent persistence',retryable:true,
            expectedStates:['submitted'],
          });
          const sniper = snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
          if (failed && sniper) await repository.requeueRetryable(failed,sniper.maxAttempts);
          return;
        }
        // A null signed hash is definitive evidence that the process stopped after persisting the
        // intent but before signing/broadcast. Finalize that unbroadcast reservation, then allow a
        // fresh bounded attempt with a new idempotency key; it is safe because no provider ever
        // received transaction bytes for this intent.
        if (!intent.txHash) {
          if (intentRepository.transition) await intentRepository.transition(intent.intentId,'reverted',{
            reason:'sniper attempt ended before signing or broadcast',
          });
          const failed = await repository.transition(event,'failed',{
            intentId:intent.intentId,failureReason:'interrupted before signing or broadcast',retryable:true,
            expectedStates:['submitted'],
          });
          const sniper = snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
          if (failed && sniper) await repository.requeueRetryable(failed,sniper.maxAttempts);
          return;
        }
        if (!['confirmed','reverted','replaced'].includes(intent.state)) intent = await transactionEngine.reconcileIntent(intent);
        if (intent.state === 'confirmed') {
          const confirmed = await repository.transition(event,'confirmed',{
            intentId:intent.intentId,expectedStates:['submitted'],
          });
          if (confirmed) await emitEvent({event:confirmed,state:'confirmed',intent});
        } else if (['reverted','replaced'].includes(intent.state)) {
          const failed = await repository.transition(event,'failed',{
            intentId:intent.intentId,failureReason:`copy transaction ${intent.state}`,
            expectedStates:['submitted'],
          });
          if (failed) await emitEvent({event:failed,state:'failed',intent});
        }
      }));
    }
    const ready = await repository.listReady(chain, blockNumber, snipers);
    const results = await Promise.allSettled(ready.map(async event => {
      const sniper = snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
      if (!sniper) return 'missing';
      const sourceHash = event.sourceCurrentHash || event.txHash;
      const liveSource = await getTransaction(sourceHash);
      const sourceTx = event.observationMode === 'pending' && liveSource
        ? liveSource
        : event.observationMode === 'pending'
          ? null
          : liveSource;
      if (!sourceTx) return skip(event, 'source transaction is unavailable after confirmation wait');
      const wallet = walletFor(sniper);
      if (!wallet) return skip(event, 'firing wallet was not found');
      return execute(sniper, event, sourceTx, wallet, getReceipt);
    }));
    return results;
  }

  return { detect, execute, processPending, processBlock, validateCreate, validatePatch };
}

module.exports = { TRANSIENT_CODES, createSniperService };
