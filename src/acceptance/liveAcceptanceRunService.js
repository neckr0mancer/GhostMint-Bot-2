const { requestSchemas, ValidationError } = require('../validation/domain');
const { TransactionSafetyError } = require('../transactions/transactionEngine');

class LiveAcceptanceRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveAcceptanceRunError';
    this.code = code;
  }
}

function serializeWei(value) {
  return value === null || value === undefined ? null : value.toString();
}

function serializePreview(preview) {
  if (!preview) return null;
  return {
    simulationEnabled: preview.simulationEnabled,
    simulationPerformed: preview.simulationPerformed,
    simulationPassed: preview.simulationPassed,
    gasLimit: serializeWei(preview.gasLimit),
    estimatedCostWei: serializeWei(preview.estimatedCostWei),
    feePerGasWei: serializeWei(preview.feePerGasWei),
    mintPreview: preview.mintPreview || undefined,
  };
}

function serializeIntent(intent, explorerBaseUrl) {
  if (!intent) return null;
  return {
    intentId: intent.intentId,
    state: intent.state,
    txHash: intent.txHash,
    explorerUrl: intent.txHash && explorerBaseUrl ? `${explorerBaseUrl}${intent.txHash}` : null,
    blockNumber: intent.blockNumber,
    nonce: intent.nonce,
    gasUsed: serializeWei(intent.gasUsed),
    effectiveGasPriceWei: serializeWei(intent.effectiveGasPriceWei),
    actualNetworkCostWei: serializeWei(intent.actualNetworkCostWei),
    requiredConfirmations: intent.requiredConfirmations,
    failureReason: intent.failureReason,
  };
}

function classifyError(error) {
  if (error instanceof TransactionSafetyError) return { code: error.code, reason: error.message };
  if (error instanceof ValidationError) return { code: 'INVALID_REQUEST', reason: error.issues.map(item => `${item.field} ${item.message}`).join('; ') };
  if (error instanceof LiveAcceptanceRunError) return { code: error.code, reason: error.message };
  return { code: 'UNEXPECTED_ERROR', reason: error?.message || 'Unknown error' };
}

function createLiveAcceptanceRunService({
  governanceRepository,
  loadWallet,
  mintService,
  mintExecutionService,
  runRepository,
  chains,
  supportedChains,
  redact = value => value,
  now = () => Date.now(),
}) {
  async function persist({ input, startedAt, outcome, failure, simulationPerformed, policySnapshot, evidence, intentId }) {
    return runRepository.record({
      operatorUserId: input.operatorUserId,
      chain: input.chain,
      contractAddress: input.contractAddress,
      walletId: input.walletId,
      methodSignature: input.methodSignature,
      intentId: intentId || null,
      outcome,
      failureCode: failure ? failure.code : null,
      failureReason: failure ? redact(failure.reason) : null,
      simulationPerformed: Boolean(simulationPerformed),
      policySnapshot: policySnapshot || {},
      evidence,
      startedAt,
    });
  }

  async function run(rawInput) {
    const startedAt = now();
    const input = requestSchemas.liveAcceptanceRun(rawInput, { supportedChains });

    if (!await governanceRepository.isOwner(input.operatorUserId)) {
      return persist({
        input, startedAt, outcome: 'failed',
        failure: { code: 'OWNER_REQUIRED', reason: 'Operator user is not a governance owner' },
        evidence: { stage: 'authorization' },
      });
    }

    const chainDefinition = chains[input.chain];
    if (!chainDefinition?.isTestnet) {
      return persist({
        input, startedAt, outcome: 'failed',
        failure: { code: 'NOT_TESTNET', reason: 'Live acceptance runs may only target a chain configured as a testnet' },
        evidence: { stage: 'chain-guard' },
      });
    }

    const wallet = await loadWallet(input.operatorUserId, input.walletId);
    if (!wallet) {
      return persist({
        input, startedAt, outcome: 'failed',
        failure: { code: 'WALLET_NOT_FOUND', reason: 'Wallet was not found for this operator' },
        evidence: { stage: 'wallet-lookup' },
      });
    }
    if (wallet.chain !== input.chain) {
      return persist({
        input, startedAt, outcome: 'failed',
        failure: { code: 'WALLET_CHAIN_MISMATCH', reason: 'Wallet is not configured for the requested chain' },
        evidence: { stage: 'wallet-lookup' },
      });
    }

    let prepared;
    let preview;
    try {
      prepared = await mintService.prepare({
        contractAddress: input.contractAddress,
        methodSignature: input.methodSignature,
        arguments: [],
        walletAddress: wallet.address,
        valueWei: input.valueWei,
        chain: input.chain,
      });
      preview = await mintExecutionService.preview({
        userId: input.operatorUserId, wallet, prepared, triggerSource: 'manual',
      });
    } catch (error) {
      const failure = classifyError(error);
      return persist({
        input, startedAt, outcome: 'failed', failure,
        evidence: { stage: 'preview', preview: serializePreview(preview) },
      });
    }

    const policySnapshot = { simulationEnabled: preview.simulationEnabled, simulationPerformed: preview.simulationPerformed };

    try {
      const intent = await mintExecutionService.executePrepared({
        userId: input.operatorUserId,
        wallet,
        prepared,
        triggerSource: 'manual',
        idempotencyKey: `live-acceptance:${input.operatorUserId}:${startedAt}`,
      });
      const passed = intent.state === 'confirmed';
      return persist({
        input, startedAt, intentId: intent.intentId,
        outcome: passed ? 'passed' : 'failed',
        failure: passed ? null : { code: 'NOT_CONFIRMED', reason: intent.failureReason || `Intent ended in state ${intent.state}` },
        simulationPerformed: preview.simulationPerformed,
        policySnapshot,
        evidence: {
          stage: 'submit',
          preview: serializePreview(preview),
          intent: serializeIntent(intent, chainDefinition.ex),
        },
      });
    } catch (error) {
      const failure = classifyError(error);
      return persist({
        input, startedAt, outcome: 'failed', failure,
        simulationPerformed: preview.simulationPerformed,
        policySnapshot,
        evidence: { stage: 'submit', preview: serializePreview(preview) },
      });
    }
  }

  return { run };
}

module.exports = { LiveAcceptanceRunError, createLiveAcceptanceRunService };
