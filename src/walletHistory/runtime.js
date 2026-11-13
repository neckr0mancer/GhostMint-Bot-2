'use strict';

const { createGoldRushWalletHistoryAdapter } = require('./goldRushAdapter');
const { createWalletHistoryProviderRegistry } = require('./provider');
const { createRpcFinalityVerifier } = require('./rpcFinalityVerifier');
const { createWalletHistoryService } = require('./service');
const { createWalletHistoryWorker } = require('./worker');

function createWalletHistoryRuntime({ repository, supportedChains = [], goldRush = {}, worker = {},
  fetchImpl = globalThis.fetch, providerService = null, log = () => {} } = {}) {
  const goldRushEnabled = goldRush.enabled === true;
  const workerEnabled = worker.enabled === true;
  const chains = Array.isArray(goldRush.chains) ? [...goldRush.chains] : [];
  if (workerEnabled && !goldRushEnabled) {
    throw new TypeError('wallet history worker requires an enabled provider adapter');
  }
  if (goldRushEnabled && (typeof goldRush.apiKey !== 'string' || !goldRush.apiKey.trim())) {
    throw new TypeError('enabled GoldRush wallet history requires an API key');
  }
  if (goldRushEnabled && chains.length === 0) {
    throw new TypeError('enabled GoldRush wallet history requires at least one chain');
  }
  if (goldRushEnabled && (!providerService || typeof providerService.perform !== 'function'
    || typeof providerService.expectedChainId !== 'function')) {
    throw new TypeError('enabled GoldRush wallet history requires RPC finality verification');
  }

  const finalityVerifier = goldRushEnabled ? createRpcFinalityVerifier({ providerService }) : null;
  const adapters = goldRushEnabled ? [createGoldRushWalletHistoryAdapter({
    apiKey:goldRush.apiKey,
    chains,
    fetchImpl,
    finalityVerifier,
    // Until the provider supplies a documented bounded-reorg contract, the only safe ingestion
    // mode is partial finalized history. Coverage and provenance remain deliberately incomplete.
    finalizedOnly:true,
  })] : [];
  const providerRegistry = createWalletHistoryProviderRegistry({ adapters });
  const service = createWalletHistoryService({
    repository,
    providerRegistry,
    defaultProviderKey:goldRushEnabled ? 'goldrush' : null,
    supportedChains,
    syncEnabled:workerEnabled,
  });
  const historyWorker = workerEnabled ? createWalletHistoryWorker({
    repository,
    service,
    intervalMs:worker.intervalMs,
    leaseMs:worker.leaseMs,
    log,
  }) : null;

  function health() {
    return historyWorker?.health?.() || {
      status:'disabled',
      running:false,
      active:false,
      providerConfigured:goldRushEnabled,
      detail:'wallet history worker is not enabled',
    };
  }

  return Object.freeze({
    providerRegistry,
    service,
    worker:historyWorker,
    health,
  });
}

module.exports = { createWalletHistoryRuntime };
