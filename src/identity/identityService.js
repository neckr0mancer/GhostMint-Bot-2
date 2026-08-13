const { createHash, randomBytes } = require('node:crypto');

const SUPPORTED_PLATFORMS = new Set(['telegram', 'discord']);
const DEFAULT_LINK_TTL_MS = 5 * 60 * 1000;

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

function createIdentityService(identityRepository, { now = () => Date.now(), linkTtlMs = DEFAULT_LINK_TTL_MS } = {}) {
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
      return result.userId;
    },

    async consumeDashboardLinkCode(code) {
      const result = await identityRepository.consumeLinkCodeForSession({ codeHash:hashCode(code), now:now() });
      if (result.status === 'invalid') throw new LinkCodeError('Link code is invalid, expired, or already used');
      return result.userId;
    },
  };
}

module.exports = { DEFAULT_LINK_TTL_MS, LinkCodeError, createIdentityService, hashCode };
