const { parseEther, parseUnits } = require('ethers');
const { ValidationError, requestSchemas } = require('../validation/domain');

const TRANSIENT_CODES = new Set(['RPC_UNAVAILABLE','BROADCAST_UNKNOWN','NETWORK_ERROR','SERVER_ERROR','TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN']);
const lower = value => String(value || '').toLowerCase();

function createSniperService({ repository, intentRepository, transactionEngine, supportedChains, now = () => Date.now(),
  onEvent = async () => {}, beforeExecute = async () => true }) {
  function validateCreate(input) { return requestSchemas.sniperCreate(input, { supportedChains }); }
  function validatePatch(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError({ field:'patch', message:'must be an object' });
    const allowed = new Set(['label','targetAddress','chain','walletLabel','valueMode','fixedValueETH','maxValueETH',
      'gasBoostPercent','maxGasGwei','dailySpendingCapETH','cooldownMs','maxAttempts','contractAllowlist',
      'contractDenylist','sourceConfirmations','active']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new ValidationError({ field:key, message:'cannot be patched' });
    if (patch.active !== undefined && typeof patch.active !== 'boolean') throw new ValidationError({ field:'active', message:'must be a boolean' });
    return { ...current, ...validateCreate({ ...current, ...patch }), active:patch.active === undefined ? current.active : patch.active };
  }

  async function skip(event, reason) {
    await repository.transition(event, 'skipped', { skipReason:reason });
    await onEvent({ event, state:'skipped', reason });
    return 'skipped';
  }

  async function execute(sniper, event, sourceTx, wallet, getReceipt = hash => sourceTx.provider.getTransactionReceipt(hash)) {
    const canonical = await getReceipt(event.txHash);
    if (!canonical || canonical.blockHash !== event.sourceBlockHash || canonical.status !== 1) {
      return skip(event, 'source transaction was dropped or changed by a chain reorganization');
    }
    const contract = lower(sourceTx.to);
    if (sniper.contractDenylist.map(lower).includes(contract)) return skip(event, 'contract is denylisted');
    if (sniper.contractAllowlist.length && !sniper.contractAllowlist.map(lower).includes(contract)) return skip(event, 'contract is not allowlisted');
    if (sniper.lastFiredAt && now() - sniper.lastFiredAt < sniper.cooldownMs) return skip(event, 'sniper cooldown is active');

    let value = sourceTx.value ?? 0n;
    if (sniper.valueMode === 'fixed') value = parseEther(String(sniper.fixedValueETH));
    if (value > parseEther(String(sniper.maxValueETH))) return skip(event, 'maximum copied value exceeded');
    const spent = await repository.dailySpendWei(sniper.userId, sniper.id, now() - 86_400_000);
    if (spent + value > parseEther(String(sniper.dailySpendingCapETH))) return skip(event, 'daily sniper spending cap exceeded');

    const boost = BigInt(100 + sniper.gasBoostPercent);
    const sourceFee = sourceTx.maxFeePerGas ?? sourceTx.gasPrice ?? 0n;
    const copiedFee = sourceFee * boost / 100n;
    if (copiedFee > parseUnits(String(sniper.maxGasGwei), 'gwei')) return skip(event, 'maximum gas price exceeded');
    if (!await beforeExecute({ sniper, event, sourceTx, wallet, value, copiedFee })) {
      return skip(event, 'waiting for explicit trigger confirmation');
    }
    const claimed = await repository.claim(event, sniper.maxAttempts);
    if (!claimed) return 'duplicate';
    try {
      const intent = await transactionEngine.submit({ userId:sniper.userId, wallet, targetId:sniper.id,
        chain:sniper.chain, triggerSource:'blockchain', to:sourceTx.to, data:sourceTx.data, valueWei:value,
        gasPriceWei:sourceTx.maxFeePerGas ? undefined : copiedFee,
        maxFeePerGasWei:sourceTx.maxFeePerGas ? copiedFee : undefined,
        maxPriorityFeePerGasWei:sourceTx.maxFeePerGas
          ? (sourceTx.maxPriorityFeePerGas || sourceTx.maxFeePerGas) * boost / 100n : undefined,
        idempotencyKey:`sniper:${sniper.userId}:${sniper.id}:${event.txHash}`,
        onIntentPersisted:intent => repository.transition(claimed,'submitted',{intentId:intent.intentId,valueWei:value}) });
      await repository.transition(claimed, intent.state === 'confirmed' ? 'confirmed' : 'submitted',
        { intentId:intent.intentId, valueWei:value });
      await onEvent({ event:claimed, state:intent.state === 'confirmed' ? 'confirmed' : 'submitted', intent });
      return intent.state === 'confirmed' ? 'confirmed' : 'submitted';
    } catch (error) {
      const retryable = TRANSIENT_CODES.has(error?.code);
      await repository.transition(claimed, 'failed', { failureReason:String(error?.message || 'copy failed').slice(0,500), retryable });
      await onEvent({ event:claimed, state:'failed', error });
      if (retryable && claimed.attemptCount < sniper.maxAttempts) await repository.requeueRetryable(claimed, sniper.maxAttempts);
      return 'failed';
    }
  }

  async function detect(sniper, tx) {
    return repository.detect(sniper, tx);
  }

  async function processBlock(chain, blockNumber, snipers, getTransaction, getReceipt, walletFor) {
    if (intentRepository) {
      const submitted = await repository.listSubmitted(chain);
      await Promise.allSettled(submitted.map(async event => {
        let intent = event.transactionIntentId ? await intentRepository.get(event.transactionIntentId) : null;
        if (!intent) intent = await intentRepository.getByIdempotencyKey(`sniper:${event.userId}:${event.sniperId}:${event.txHash}`);
        if (!intent) {
          await repository.transition(event,'failed',{failureReason:'interrupted before transaction intent persistence',retryable:true});
          const sniper = snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
          if (sniper) await repository.requeueRetryable(event,sniper.maxAttempts);
          return;
        }
        if (!['confirmed','reverted','replaced'].includes(intent.state)) intent = await transactionEngine.reconcileIntent(intent);
        if (intent.state === 'confirmed') {
          await repository.transition(event,'confirmed',{intentId:intent.intentId});
          await onEvent({event,state:'confirmed',intent});
        } else if (['reverted','replaced'].includes(intent.state)) {
          await repository.transition(event,'failed',{intentId:intent.intentId,failureReason:`copy transaction ${intent.state}`});
          await onEvent({event,state:'failed',intent});
        }
      }));
    }
    const ready = await repository.listReady(chain, blockNumber, snipers);
    const results = await Promise.allSettled(ready.map(async event => {
      const sniper = snipers.find(item => item.userId === event.userId && item.id === event.sniperId);
      if (!sniper) return 'missing';
      const sourceTx = await getTransaction(event.txHash);
      if (!sourceTx) return skip(event, 'source transaction is unavailable after confirmation wait');
      const wallet = walletFor(sniper);
      if (!wallet) return skip(event, 'firing wallet was not found');
      return execute(sniper, event, sourceTx, wallet, getReceipt);
    }));
    return results;
  }

  return { detect, execute, processBlock, validateCreate, validatePatch };
}

module.exports = { TRANSIENT_CODES, createSniperService };
