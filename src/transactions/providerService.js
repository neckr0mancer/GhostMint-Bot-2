const { JsonRpcProvider } = require('ethers');

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

  async function perform(chain, operationName, operation) {
    const candidates = chainProviders(chain);
    let attempts = 0;
    for (const candidate of candidates) {
      for (let retry = 0; retry <= retries; retry += 1) {
        attempts += 1;
        try {
          return await withTimeout(
            Promise.resolve().then(() => operation(candidate.provider)),
            timeoutMs,
            `${chain} ${operationName}`,
          );
        } catch {
          // Try the same endpoint according to policy, then fail over.
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
