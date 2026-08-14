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

function createFlowStateStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const flows = new Map();

  function key(platform, chatId) {
    return `${platform}:${chatId}`;
  }

  function expired(entry) {
    return !entry || now() - entry.updatedAt > ttlMs;
  }

  return {
    // Returns the active flow for this chat, or null if none exists or it has expired.
    get(platform, chatId) {
      const entry = flows.get(key(platform, chatId));
      if (expired(entry)) {
        flows.delete(key(platform, chatId));
        return null;
      }
      return entry;
    },

    // Starts or replaces a flow outright (no confirmation) — used once the user has already
    // agreed to abandon whatever was there before, or when starting fresh.
    start(platform, chatId, flow, step, data = {}) {
      const value = { flow, step, data, updatedAt: now(), pendingCancel: false };
      flows.set(key(platform, chatId), value);
      return value;
    },

    // Advances the current flow to a new step without asking for confirmation (normal forward
    // progress within the same guided flow).
    advance(platform, chatId, step, data) {
      const existing = flows.get(key(platform, chatId));
      if (!existing) return null;
      existing.step = step;
      if (data !== undefined) existing.data = { ...existing.data, ...data };
      existing.updatedAt = now();
      existing.pendingCancel = false;
      return existing;
    },

    // Marks the current flow as "about to be abandoned" so the next explicit confirm/resume
    // action is unambiguous even if further unrelated messages arrive in between.
    markPendingCancel(platform, chatId) {
      const existing = flows.get(key(platform, chatId));
      if (!existing) return null;
      existing.pendingCancel = true;
      existing.updatedAt = now();
      return existing;
    },

    clearPendingCancel(platform, chatId) {
      const existing = flows.get(key(platform, chatId));
      if (!existing) return null;
      existing.pendingCancel = false;
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
