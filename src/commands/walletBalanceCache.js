// walletBalance() fans a single call out across every supported chain (see botCommandService.js).
// Rendering it on /start, /wallets, and /address -- on every single interaction, for every wallet
// a user has -- turns "live balances" into exactly the RPC-rate-limit trap that invites: N chains
// x M wallets x every open chat/dashboard. A short TTL keeps repeated reads free while still
// looking live; logActivity invalidates the specific wallet's entry the moment a mint actually
// confirms, so a just-completed transaction is never masked by a stale cached read.

const DEFAULT_TTL_MS = 20_000;

function createWalletBalanceCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), sweepThreshold = 10_000 } = {}) {
  const entries = new Map();

  function key(userId, label) {
    return `${userId}:${label}`;
  }

  function expired(entry) {
    return !entry || now() - entry.at > ttlMs;
  }

  // Mirrors flowState.js's lazy-sweep pattern: get()/set() only ever clean up the one key they
  // touch, so a cache that's read once and never invalidated (a wallet nobody mints from again)
  // would otherwise sit here forever. Only sweeping once the map has grown large keeps the common
  // case free of extra work.
  function sweepIfLarge() {
    if (entries.size < sweepThreshold) return;
    for (const [entryKey, entry] of entries) if (expired(entry)) entries.delete(entryKey);
  }

  return {
    get(userId, label) {
      const mapKey = key(userId, label);
      const entry = entries.get(mapKey);
      if (expired(entry)) {
        entries.delete(mapKey);
        return null;
      }
      return entry.value;
    },
    set(userId, label, value) {
      sweepIfLarge();
      entries.set(key(userId, label), { value, at: now() });
    },
    invalidate(userId, label) {
      entries.delete(key(userId, label));
    },
  };
}

module.exports = { DEFAULT_TTL_MS, createWalletBalanceCache };
