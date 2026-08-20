// getFeeData() fans out to three concurrent RPC legs (block, gas price, priority fee) every time
// it's called, and transactionEngine.submit() calls it fresh on every mint -- fine for a manual
// mint a human just confirmed, where a live quote is the point, but a real cost for scheduled and
// Degen-mode mints, where speed is the point and a few seconds of staleness changes nothing: the
// gas ceiling check downstream still rejects anything the cached value under-quoted, and Degen's
// own gasPriceMultiplier already pads the bid. A short TTL lets a second scheduled/Degen mint on
// the same chain within the window skip the round trip entirely, without ever touching a manual
// mint's guarantee of a fresh quote. Keyed by chain only -- fee data isn't wallet- or user-specific.

const DEFAULT_TTL_MS = 5_000;

function createFeeDataCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(chain) {
      const entry = entries.get(chain);
      if (!entry || now() - entry.at > ttlMs) {
        entries.delete(chain);
        return null;
      }
      return entry.value;
    },
    set(chain, value) {
      entries.set(chain, { value, at: now() });
    },
  };
}

module.exports = { DEFAULT_TTL_MS, createFeeDataCache };
