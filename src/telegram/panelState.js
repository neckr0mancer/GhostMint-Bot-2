// Per-chat "live panel" bookkeeping for the Telegram bot. The bot keeps a single message per chat
// that it edits in place as the user moves through menus and flows, rather than posting a new
// bubble for every step. This module owns the one genuinely subtle decision in that scheme:
// whether the panel can still be edited where it sits, or has to move.
//
// The rule: editing in place is only correct while the panel is the newest message in the chat.
// Once the user has sent anything below it -- a slash command, a pasted contract address -- an
// edit would update a bubble that now sits ABOVE their message, so the conversation reads out of
// order and the panel appears to answer before the question was asked. In that case the caller
// should send a fresh panel at the bottom and remove the stale one.
//
// Telegram message ids are per-chat sequential integers, so `newest > anchor` decides this without
// needing an API call to inspect the chat. This module is deliberately pure state -- it performs
// no Telegram calls itself -- so the ordering logic is unit-testable in isolation, the same way
// flowState.js separates flow sequencing from delivery.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function createPanelStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), sweepThreshold = 10_000 } = {}) {
  const panels = new Map();

  function read(chatId) {
    return panels.get(chatId) || { anchor: null, newest: 0, at: 0 };
  }

  // One entry per chat that ever messaged the bot would otherwise be retained for the process's
  // whole life. Only sweeping once the map is genuinely large keeps the common case free of work,
  // matching flowState.js's sweepIfLarge idiom.
  function sweepIfLarge() {
    if (panels.size < sweepThreshold) return;
    const cutoff = now() - ttlMs;
    for (const [key, value] of panels) if (value.at < cutoff) panels.delete(key);
  }

  function write(chatId, patch) {
    const next = { ...read(chatId), ...patch, at: now() };
    // The anchor is itself a message in the chat, so it can never be older than `newest`.
    if (next.anchor && next.anchor > next.newest) next.newest = next.anchor;
    panels.set(chatId, next);
    // Swept after the insert, not before, so the threshold test sees the map's true size --
    // sweeping first meant a store sitting one entry below the threshold never swept at all. The
    // entry just written is always fresh, so it is never the one dropped.
    sweepIfLarge();
    return next;
  }

  return {
    read,

    // The bot sent or took over a message as the chat's live panel.
    noteAnchor(chatId, messageId) {
      if (!chatId || !messageId) return null;
      return write(chatId, { anchor: messageId });
    },

    // An inbound user message arrived, and now sits below the panel.
    noteIncoming(chatId, messageId) {
      if (!chatId || !messageId) return null;
      return write(chatId, { newest: messageId });
    },

    // A message the bot had counted was successfully deleted (guided flows consume and delete the
    // user's reply). If it was the newest thing in the chat, it no longer displaces the panel, so
    // forget it -- otherwise the panel would pointlessly move to get below a message that is no
    // longer visible to anyone.
    noteDeleted(chatId, messageId) {
      if (!chatId || !messageId) return null;
      const current = read(chatId);
      if (current.newest !== messageId) return current;
      return write(chatId, { newest: current.anchor || 0 });
    },

    // True when the panel can no longer be edited where it is.
    shouldMove(chatId) {
      const { anchor, newest } = read(chatId);
      return Boolean(anchor) && newest > anchor;
    },

    size() { return panels.size; },
  };
}

module.exports = { createPanelStore, DEFAULT_TTL_MS };
