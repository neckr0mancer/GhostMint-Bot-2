const { createHash, randomBytes } = require('node:crypto');
const { ValidationError } = require('../validation/domain');

const SUPPORTED_PLATFORMS = new Set(['telegram', 'discord']);
const DEFAULT_LINK_TTL_MS = 5 * 60 * 1000;
const MERGE_ERROR_FIELDS = {
  SOURCE_NOT_FOUND: 'sourcePlatformUserId',
  TARGET_NOT_FOUND: 'targetPlatformUserId',
  SAME_ACCOUNT: 'targetPlatformUserId',
  ACCOUNT_NOT_EMPTY: 'sourcePlatformUserId',
};

class LinkCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkCodeError';
  }
}

function normalizeIdentity(platform, platformUserId) {
  const normalizedPlatform = String(platform || '').toLowerCase();
  const normalizedId = String(platformUserId || '').trim();
  if (!SUPPORTED_PLATFORMS.has(normalizedPlatform)) throw new Error('Unsupported identity platform');
  if (!normalizedId) throw new Error('Platform user ID is required');
  return { platform: normalizedPlatform, platformUserId: normalizedId };
}

function hashCode(code) {
  return createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

function createIdentityService(identityRepository, { now = () => Date.now(), linkTtlMs = DEFAULT_LINK_TTL_MS, broadcast } = {}) {
  return {
    resolveOrCreate(platform, platformUserId) {
      return identityRepository.resolveOrCreateIdentity(normalizeIdentity(platform, platformUserId));
    },

    async createLinkCode(userId) {
      const code = randomBytes(5).toString('hex').toUpperCase();
      const expiresAt = now() + linkTtlMs;
      await identityRepository.createLinkCode({ userId, codeHash: hashCode(code), expiresAt });
      return { code, expiresAt };
    },

    async consumeLinkCode({ code, platform, platformUserId }) {
      const identity = normalizeIdentity(platform, platformUserId);
      const result = await identityRepository.consumeLinkCode({
        codeHash: hashCode(code),
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        now: now(),
      });
      if (result.status === 'invalid') throw new LinkCodeError('Link code is invalid, expired, or already used');
      if (result.status === 'conflict') throw new LinkCodeError('This platform account is already linked to another user');
      // Consumed exclusively via Discord's /link command (Telegram only ever generates a code) --
      // nothing about a REST write here to broadcast from, so the dashboard would otherwise have no
      // way to know linkedAccounts changed short of a manual reload.
      broadcast?.(result.userId, { type: 'identity.changed' });
      return result.userId;
    },

    async consumeDashboardLinkCode(code) {
      const result = await identityRepository.consumeLinkCodeForSession({ codeHash:hashCode(code), now:now() });
      if (result.status === 'invalid') throw new LinkCodeError('Link code is invalid, expired, or already used');
      return result.userId;
    },

    // Owner-only (gated by the caller, same as every other admin action): repoints a platform
    // identity that ended up on its own separate account -- because both platforms auto-create one
    // on first contact, before ever using a link code -- onto an existing account, and removes the
    // empty duplicate. Refuses and changes nothing if the duplicate has any real data; see
    // postgresIdentityRepository.mergeAccount for the exact emptiness check.
    async mergeAccount({ sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId }) {
      const source = normalizeIdentity(sourcePlatform, sourcePlatformUserId);
      const target = normalizeIdentity(targetPlatform, targetPlatformUserId);
      try {
        return await identityRepository.mergeAccount({
          sourcePlatform: source.platform, sourcePlatformUserId: source.platformUserId,
          targetPlatform: target.platform, targetPlatformUserId: target.platformUserId,
        });
      } catch (error) {
        const field = MERGE_ERROR_FIELDS[error.code];
        if (field) throw new ValidationError({ field, message: error.message });
        throw error;
      }
    },
  };
}

module.exports = { DEFAULT_LINK_TTL_MS, LinkCodeError, createIdentityService, hashCode };
