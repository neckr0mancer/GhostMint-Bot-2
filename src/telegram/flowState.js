// Per-chat guided-flow tracker for Milestone 15b. This is presentation-layer sequencing only:
// it never stores secrets, never bypasses validation, and never itself calls the transaction
// engine. It just remembers "what step of a guided menu flow is this chat on" so the bot can
// prompt for confirmation before discarding in-progress work (e.g. a half-finished wallet
// creation) instead of silently abandoning it.
//
// State is in-memory and intentionally not durable: a bot restart clears all in-progress guided
// flows, which is safe because nothing of consequence (a submitted transaction, a saved wallet)
// exists only in this store. It always exists in the same durable services every other command
// already uses.

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createFlowStateStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), sweepThreshold = 10_000 } = {}) {
  const flows = new Map();

  function key(platform, chatId) {
    return `${platform}:${chatId}`;
  }

  function expired(entry) {
    return !entry || now() - entry.updatedAt > ttlMs;
  }

  // get()'s lazy expiry only ever cleans up the ONE key being read, so a chat that starts a flow and
  // then never sends another message leaves its entry in `flows` forever -- directly contradicting
  // this store's own "in-memory, bounded, ephemeral" design intent above. Only sweeping once the map
  // has grown large keeps the common case free of extra work.
  function sweepIfLarge() {
    if (flows.size < sweepThreshold) return;
    for (const [entryKey, entry] of flows) if (expired(entry)) flows.delete(entryKey);
  }

  // Shared by every read/mutate method below so expiry is self-enforced here rather than relying on
  // every caller to have already called get() first (which happens to be true at every current call
  // site, but isn't a guarantee this store itself makes).
  function activeEntry(platform, chatId) {
    const mapKey = key(platform, chatId);
    const entry = flows.get(mapKey);
    if (!expired(entry)) return entry;
    flows.delete(mapKey);
    return null;
  }

  return {
    // Returns the active flow for this chat, or null if none exists or it has expired.
    get(platform, chatId) {
      return activeEntry(platform, chatId);
    },

    // Starts or replaces a flow outright -- used both for a genuinely fresh flow and for
    // implicitly abandoning whatever was there before (mid-flow divergence no longer asks for
    // confirmation first; the caller just clears, then starts the new one).
    start(platform, chatId, flow, step, data = {}) {
      sweepIfLarge();
      const value = { flow, step, data, updatedAt: now() };
      flows.set(key(platform, chatId), value);
      return value;
    },

    // Advances the current flow to a new step (normal forward progress within the same guided flow).
    advance(platform, chatId, step, data) {
      const existing = activeEntry(platform, chatId);
      if (!existing) return null;
      existing.step = step;
      if (data !== undefined) existing.data = { ...existing.data, ...data };
      existing.updatedAt = now();
      return existing;
    },

    // Fully discards the flow, per Milestone 15b: cancelling must leave nothing behind.
    clear(platform, chatId) {
      flows.delete(key(platform, chatId));
    },
  };
}

module.exports = { DEFAULT_TTL_MS, createFlowStateStore };
