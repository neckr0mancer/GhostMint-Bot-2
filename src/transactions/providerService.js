const { JsonRpcProvider } = require('ethers');

// Error codes ethers uses for a definitive answer from a provider that was actually reached --
// retrying or failing over to a different RPC endpoint cannot change these (a different node won't
// suddenly know the wallet has funds, that the call wouldn't revert, or that the nonce/replacement
// is permanently unpriceable), so they should propagate immediately with their real reason intact
// rather than being swallowed into a generic "RPC providers failed" message after wasting retries.
const NON_RETRYABLE_ERROR_CODES = new Set([
  'CALL_EXCEPTION',
  'INSUFFICIENT_FUNDS',
  'NONCE_EXPIRED',
  'REPLACEMENT_UNDERPRICED',
  'UNPREDICTABLE_GAS_LIMIT',
]);

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

  // TX-004 (Model 2 phase-1 re-review): a definitive rejection from ONE endpoint must never
  // hide another endpoint's ACCEPTANCE, and a TIMED-OUT candidate must make the aggregate
  // ambiguous -- the timed-out request may still have been accepted after we stopped waiting.
  // Success wins unconditionally. Only when every candidate has definitively rejected (none
  // timed out, none succeeded) is a definitive code surfaced. Any timeout in the set produces
  // an ambiguous RpcUnavailableError so the engine records `unknown`, not a false-final state.
  async function performAll(chain, operationName, operation, { timeoutMs: timeoutOverride } = {}) {
    const candidates = chainProviders(chain);
    const effectiveTimeoutMs = timeoutOverride ?? timeoutMs;
    return new Promise((resolve, reject) => {
      let pending = candidates.length;
      let settled = false;
      let definitiveError = null;
      let anyTimedOut = false;
      for (const candidate of candidates) {
        withTimeout(
          Promise.resolve().then(() => operation(candidate.provider)),
          effectiveTimeoutMs,
          `${chain} ${operationName}`,
        ).then(value => {
          if (!settled) { settled = true; resolve(value); }
        }).catch(error => {
          if (!settled) {
            if (error?.message?.includes('timed out')) anyTimedOut = true;
            else if (NON_RETRYABLE_ERROR_CODES.has(error?.code) && !definitiveError) definitiveError = error;
            pending -= 1;
            if (pending === 0) {
              settled = true;
              // A definitive code is trustworthy only when every candidate explicitly and
              // definitively rejected. Any timeout makes the aggregate ambiguous.
              if (definitiveError && !anyTimedOut) reject(definitiveError);
              else reject(new RpcUnavailableError(chain, candidates.length));
            }
          }
        });
      }
    });
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

  return { destroy, expectedChainId, perform, performAll };
}

module.exports = { RpcUnavailableError, createProviderService, withTimeout };
