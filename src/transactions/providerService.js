const { JsonRpcProvider } = require('ethers');

// Error codes ethers uses for a definitive answer from a provider that was actually reached --
// retrying or failing over to a different RPC endpoint cannot change these (a different node won't
// suddenly know the wallet has funds, or that the call wouldn't revert), so they should propagate
// immediately with their real reason intact rather than being swallowed into a generic
// "RPC providers failed" message after wasting retries.
const NON_RETRYABLE_ERROR_CODES = new Set(['CALL_EXCEPTION', 'INSUFFICIENT_FUNDS']);

class RpcUnavailableError extends Error {
  constructor(chain, attempts) {
    super(`All RPC providers failed for ${chain} after ${attempts} attempts`);
    this.name = 'RpcUnavailableError';
    this.code = 'RPC_UNAVAILABLE';
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function createProviderService({ chains, timeoutMs = 10_000, retries = 1, providerFactory } = {}) {
  const makeProvider = providerFactory || (url => new JsonRpcProvider(url));
  const providers = new Map();

  function chainProviders(chain) {
    if (providers.has(chain)) return providers.get(chain);
    const definition = chains[chain];
    if (!definition?.rpcUrls?.length) throw new RpcUnavailableError(chain, 0);
    const result = definition.rpcUrls.map((url, index) => ({ url, index, provider: makeProvider(url, chain) }));
    providers.set(chain, result);
    return result;
  }

  // timeoutMs/retries overrides let a caller opt into a tighter failover budget for one call --
  // used for scheduled and Degen-mode mints (transactionEngine.js), where a slow primary RPC
  // should be abandoned quickly rather than eating the full default timeout on every retry before
  // even reaching the next configured URL. Every other caller is unaffected: omitting the third
  // argument keeps the constructor's own defaults exactly as before this existed.
  async function perform(chain, operationName, operation, { timeoutMs: timeoutOverride, retries: retriesOverride } = {}) {
    const candidates = chainProviders(chain);
    const effectiveTimeoutMs = timeoutOverride ?? timeoutMs;
    const effectiveRetries = retriesOverride ?? retries;
    let attempts = 0;
    for (const candidate of candidates) {
      for (let retry = 0; retry <= effectiveRetries; retry += 1) {
        attempts += 1;
        try {
          return await withTimeout(
            Promise.resolve().then(() => operation(candidate.provider)),
            effectiveTimeoutMs,
            `${chain} ${operationName}`,
          );
        } catch (error) {
          if (NON_RETRYABLE_ERROR_CODES.has(error?.code)) throw error;
        }
      }
    }
    throw new RpcUnavailableError(chain, attempts);
  }

  function destroy() {
    for (const candidates of providers.values()) {
      for (const candidate of candidates) candidate.provider.destroy?.();
    }
    providers.clear();
  }

  function expectedChainId(chain) {
    return chains[chain]?.chainId ?? null;
  }

  return { destroy, expectedChainId, perform };
}

module.exports = { RpcUnavailableError, createProviderService, withTimeout };
