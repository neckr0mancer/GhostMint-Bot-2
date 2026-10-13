const { randomUUID } = require('node:crypto');
const { createRedactor } = require('../security/redaction');

const redact = createRedactor();

function safeError(error) {
  return redact(error?.message || error || 'wallet history sync failed')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

function createWalletHistoryWorker({ repository, service, workerId = randomUUID(),
  now = () => Date.now(), intervalMs = 15_000, leaseMs = 90_000, log = () => {} } = {}) {
  if (!repository?.claimDue || !repository?.releaseClaim) {
    throw new TypeError('wallet history worker repository is required');
  }
  if (!service?.runSyncPage) throw new TypeError('wallet history worker service is required');
  if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('workerId is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 10 * 60_000) {
    throw new TypeError('intervalMs must be between 1000 and 600000');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
    throw new TypeError('leaseMs must be between 1000 and 600000');
  }
  const owner = workerId.trim().toLowerCase();
  let timer = null;
  let activeTick = null;
  let lastTickAt = null;
  let lastSuccessAt = null;
  let lastError = null;

  async function processClaim(claim) {
    try {
      return await service.runSyncPage(claim.userId, {
        address:claim.walletAddress, chain:claim.chain,
      }, {
        chain:claim.chain, providerKey:claim.providerKey, workerId:owner,
      });
    } catch (error) {
      lastError = safeError(error);
      log(`Wallet history sync failed safely for ${claim.chain}: ${lastError}`);
      // runSyncPage normally releases the lease while recording its safe error. This is a guarded
      // fallback for failures before that boundary; an expired/stolen claim cannot be released.
      await repository.releaseClaim({ userId:claim.userId, chain:claim.chain,
        walletAddress:claim.walletAddress, workerId:owner }).catch(() => {});
      return null;
    }
  }

  function tick() {
    if (activeTick) return activeTick;
    lastTickAt = now();
    activeTick = (async () => {
      try {
        const claim = await repository.claimDue({ workerId:owner, now:lastTickAt, leaseMs });
        if (!claim) {
          lastSuccessAt = now();
          lastError = null;
          return false;
        }
        const result = await processClaim(claim);
        if (result) {
          lastSuccessAt = now();
          lastError = null;
        }
        return Boolean(result);
      } catch (error) {
        lastError = safeError(error);
        log(`Wallet history worker failed safely: ${lastError}`);
        return false;
      }
    })().finally(() => { activeTick = null; });
    return activeTick;
  }

  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (activeTick) await activeTick;
  }

  function health() {
    return {
      status:timer ? (lastError && (!lastSuccessAt || lastSuccessAt < lastTickAt) ? 'down' : 'up') : 'stopped',
      running:Boolean(timer), active:Boolean(activeTick), workerId:owner,
      lastTickAt,lastSuccessAt,lastError,
    };
  }

  return { workerId:owner, health, processClaim, start, stop, tick };
}

module.exports = { createWalletHistoryWorker, safeError };
