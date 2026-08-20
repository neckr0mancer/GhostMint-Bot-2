// Password gate for sensitive actions taken from Telegram and Discord.
//
// The dashboard has required an account password for its sensitive actions since migration 036.
// The bots required nothing: anyone holding an unlocked phone could remove a wallet, export a key,
// or send funds straight out of the chat. This closes that, reusing the SAME password rather than
// introducing a second one -- one password, three surfaces, verified against the same scrypt hash
// on users.security_password_hash by src/security/securityPassword.js.
//
// Two things this deliberately does NOT do:
//
//   * It never lets a password be SET from chat. Setting one would put it in message history
//     permanently, which is the exact exposure the gate exists to reduce. An account with no
//     password set is told to set it on the dashboard, and the action is refused meanwhile.
//
//   * It does not treat "unlocked" as an account-wide state. An unlock belongs to one platform
//     conversation (a Telegram chat, a Discord user), so unlocking on a phone in your pocket does
//     not silently unlock a session someone else is looking at.
//
// Typing a password into a chat is weaker than typing it into the dashboard no matter what we do
// here -- on Telegram it crosses their servers and can sit in history. Discord is verified through
// a MODAL, whose input never becomes a message at all; Telegram deletes the message on receipt,
// the same mitigation already used for private keys. Neither is as good as the dashboard, and the
// copy in the bots says so rather than implying the gate makes chat safe.

const LEVELS = Object.freeze(['off', 'sensitive', 'strict']);

// What each action costs if it is wrong. `sensitive` is the irreversible or key-exposing set;
// `read` is everything that merely discloses holdings. An action absent from here is ungated at
// every level -- that is the safe default for a gate that ships off, since a missing entry can
// only ever fail open to today's behaviour rather than locking someone out of something new.
const ACTION_TIERS = Object.freeze({
  exportkey: 'sensitive',
  removewallet: 'sensitive',
  send: 'sensitive',
  batchimport: 'sensitive',
  importwallet: 'sensitive',
  walletlist: 'read',
  balance: 'read',
  activity: 'read',
});

const TIERS_BY_LEVEL = Object.freeze({
  off: Object.freeze([]),
  sensitive: Object.freeze(['sensitive']),
  strict: Object.freeze(['sensitive', 'read']),
});

const DEFAULT_UNLOCK_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

function normaliseLevel(value) {
  const level = String(value || 'off').toLowerCase();
  return LEVELS.includes(level) ? level : 'off';
}

// Whether `action` needs a password at `level`. Pure, so the bots can ask before doing any work.
function requiresPassword(level, action) {
  const tier = ACTION_TIERS[String(action || '').toLowerCase()];
  if (!tier) return false;
  return TIERS_BY_LEVEL[normaliseLevel(level)].includes(tier);
}

class GateLockedError extends Error {
  constructor(reason, { retryAfterMs = 0 } = {}) {
    super(reason);
    this.name = 'GateLockedError';
    this.code = 'GATE_LOCKED';
    this.retryAfterMs = retryAfterMs;
  }
}

function createActionGate({
  getLevel,
  getPasswordHash,
  verify,
  now = () => Date.now(),
  unlockMs = DEFAULT_UNLOCK_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  lockoutMs = DEFAULT_LOCKOUT_MS,
} = {}) {
  // Keyed by platform + conversation, never by account: see the note at the top of this file.
  const unlocked = new Map();
  const attempts = new Map();
  const key = (platform, contextId) => `${platform}:${contextId}`;

  function isUnlocked(platform, contextId) {
    const until = unlocked.get(key(platform, contextId));
    if (!until) return false;
    if (until <= now()) { unlocked.delete(key(platform, contextId)); return false; }
    return true;
  }

  function unlock(platform, contextId) {
    unlocked.set(key(platform, contextId), now() + unlockMs);
  }

  function lock(platform, contextId) {
    unlocked.delete(key(platform, contextId));
  }

  function lockoutRemaining(platform, contextId) {
    const record = attempts.get(key(platform, contextId));
    if (!record || record.count < maxAttempts) return 0;
    const remaining = record.until - now();
    if (remaining <= 0) { attempts.delete(key(platform, contextId)); return 0; }
    return remaining;
  }

  function noteFailure(platform, contextId) {
    const id = key(platform, contextId);
    const record = attempts.get(id) || { count: 0, until: 0 };
    record.count += 1;
    if (record.count >= maxAttempts) record.until = now() + lockoutMs;
    attempts.set(id, record);
    return record;
  }

  // Answers "may this action proceed right now" without asking for anything. The bots call this
  // first: `false` means show the password prompt, `true` means carry on exactly as before.
  async function allows(userId, platform, contextId, action) {
    const level = normaliseLevel(await getLevel(userId));
    if (!requiresPassword(level, action)) return true;
    return isUnlocked(platform, contextId);
  }

  // Verifies a submitted password and, on success, unlocks that conversation for unlockMs.
  // Throws GateLockedError for the two cases the caller must report differently from a wrong
  // password: no password set on the account at all, and too many failed attempts.
  async function submit(userId, platform, contextId, password) {
    const waitMs = lockoutRemaining(platform, contextId);
    if (waitMs > 0) throw new GateLockedError('too many attempts', { retryAfterMs: waitMs });

    const hash = await getPasswordHash(userId);
    if (!hash) {
      throw new GateLockedError('no password set');
    }
    if (!verify(password, hash)) {
      const record = noteFailure(platform, contextId);
      const left = Math.max(0, maxAttempts - record.count);
      return { ok: false, attemptsLeft: left };
    }
    attempts.delete(key(platform, contextId));
    unlock(platform, contextId);
    return { ok: true, unlockedForMs: unlockMs };
  }

  return { allows, submit, isUnlocked, unlock, lock, requiresPassword, lockoutRemaining };
}

module.exports = {
  createActionGate,
  requiresPassword,
  normaliseLevel,
  GateLockedError,
  LEVELS,
  ACTION_TIERS,
  TIERS_BY_LEVEL,
  DEFAULT_UNLOCK_MS,
};
