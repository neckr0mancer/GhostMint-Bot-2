const { createHash, randomBytes } = require('node:crypto');
const { ValidationError } = require('../validation/domain');
const { ACCOUNT_MERGE_PLAN_VERSION } = require('./accountMergePlan');

const SUPPORTED_PLATFORMS = new Set(['telegram', 'discord']);
const DEFAULT_LINK_TTL_MS = 5 * 60 * 1000;
const MERGE_ERROR_FIELDS = {
  SOURCE_NOT_FOUND: 'sourcePlatformUserId',
  TARGET_NOT_FOUND: 'targetPlatformUserId',
  SAME_ACCOUNT: 'targetPlatformUserId',
  TARGET_PLATFORM_CONFLICT: 'targetPlatformUserId',
  ACCOUNT_NOT_EMPTY: 'sourcePlatformUserId',
};

class LinkCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkCodeError';
  }
}

function normalizeIdentity(platform, platformUserId) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedId = String(platformUserId || '').trim();
  if (!SUPPORTED_PLATFORMS.has(normalizedPlatform)) throw new Error('Unsupported identity platform');
  if (!normalizedId) throw new Error('Platform user ID is required');
  return { platform: normalizedPlatform, platformUserId: normalizedId };
}

function hashCode(code) {
  return createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

function normalizeMergeIdentity(platform, platformUserId, platformField, idField) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedId = String(platformUserId || '').trim();
  if (!SUPPORTED_PLATFORMS.has(normalizedPlatform)) {
    throw new ValidationError({ field: platformField, message: 'must be telegram or discord' });
  }
  if (!normalizedId) throw new ValidationError({ field: idField, message: 'is required' });
  return { platform: normalizedPlatform, platformUserId: normalizedId };
}

function normalizeMergeInput({ sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId } = {}) {
  const source = normalizeMergeIdentity(
    sourcePlatform, sourcePlatformUserId, 'sourcePlatform', 'sourcePlatformUserId',
  );
  const target = normalizeMergeIdentity(
    targetPlatform, targetPlatformUserId, 'targetPlatform', 'targetPlatformUserId',
  );
  return {
    sourcePlatform: source.platform,
    sourcePlatformUserId: source.platformUserId,
    targetPlatform: target.platform,
    targetPlatformUserId: target.platformUserId,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MERGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function mergeExecutionInput(actorUserId, input = {}) {
  const normalized = normalizeMergeInput(input);
  const actor = String(actorUserId || '').trim().toLowerCase();
  const sourceUserId = String(input.expectedSourceUserId || '').trim().toLowerCase();
  const targetUserId = String(input.expectedTargetUserId || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(actor)) throw new ValidationError({ field: 'actor', message: 'is invalid' });
  if (!UUID_PATTERN.test(sourceUserId)) {
    throw new ValidationError({ field: 'expectedSourceUserId', message: 'must be the reviewed duplicate account ID' });
  }
  if (!UUID_PATTERN.test(targetUserId)) {
    throw new ValidationError({ field: 'expectedTargetUserId', message: 'must be the reviewed retained account ID' });
  }
  if (sourceUserId === targetUserId) {
    throw new ValidationError({ field: 'expectedTargetUserId', message: 'must be a different account' });
  }
  const planVersion = Number(input.expectedPlanVersion);
  if (!Number.isSafeInteger(planVersion) || planVersion !== ACCOUNT_MERGE_PLAN_VERSION) {
    throw new ValidationError({ field: 'expectedPlanVersion', message: 'is stale; review the accounts again' });
  }
  const snapshotDigest = String(input.expectedSnapshotDigest || '').trim();
  if (!MERGE_DIGEST_PATTERN.test(snapshotDigest)) {
    throw new ValidationError({ field: 'expectedSnapshotDigest', message: 'must be the reviewed plan digest' });
  }
  const resolutionMap = input.resolutionMap;
  if (!resolutionMap || typeof resolutionMap !== 'object' || Array.isArray(resolutionMap)
    || Object.getPrototypeOf(resolutionMap) !== Object.prototype || Object.keys(resolutionMap).length) {
    throw new ValidationError({ field: 'resolutionMap', message: 'must be empty for this collision-free merge' });
  }
  const requiredConfirmation = `MERGE ${sourceUserId} INTO ${targetUserId}`;
  if (input.confirmationText !== requiredConfirmation) {
    throw new ValidationError({ field: 'confirmationText', message: `must exactly match ${requiredConfirmation}` });
  }
  const idempotencyPayload = JSON.stringify({
    actorUserId: actor,
    sourcePlatform: normalized.sourcePlatform,
    sourcePlatformUserId: normalized.sourcePlatformUserId,
    targetPlatform: normalized.targetPlatform,
    targetPlatformUserId: normalized.targetPlatformUserId,
    expectedSourceUserId: sourceUserId,
    expectedTargetUserId: targetUserId,
    expectedPlanVersion: planVersion,
    expectedSnapshotDigest: snapshotDigest,
    resolutionMap,
  });
  return {
    actorUserId: actor,
    ...normalized,
    expectedSourceUserId: sourceUserId,
    expectedTargetUserId: targetUserId,
    expectedPlanVersion: planVersion,
    expectedSnapshotDigest: snapshotDigest,
    resolutionMap,
    idempotencyKey: `account-merge:${createHash('sha256').update(idempotencyPayload).digest('hex')}`,
  };
}

async function withMergeValidation(operation) {
  try {
    return await operation();
  } catch (error) {
    const field = MERGE_ERROR_FIELDS[error.code];
    if (field) throw new ValidationError({ field, message: error.message });
    throw error;
  }
}

function limitedEmptyMergeAvailable(plan) {
  if (plan.classification !== 'ready'
    || plan.summary.movable.rows !== 0
    || plan.summary.blocking.rows !== 0
    || plan.summary.sourceIdentityCount !== 1) return false;
  // The existing limited merge explicitly revokes unused link codes. Every other capability,
  // including sessions and one-time bypass challenges, must fail closed until that exact executor
  // is taught to revoke it inside the same transaction.
  return plan.summary.revocable.domains.every(item => item.key === 'accountLinkCodes');
}

function createIdentityService(identityRepository, {
  now = () => Date.now(), linkTtlMs = DEFAULT_LINK_TTL_MS, broadcast,
  onAccountMergeCommitted,
} = {}) {
  return {
    resolveOrCreate(platform, platformUserId) {
      return identityRepository.resolveOrCreateIdentity(normalizeIdentity(platform, platformUserId));
    },

    getSniperObservationDefault(userId) {
      return identityRepository.getSniperObservationDefault(userId);
    },

    setSniperObservationDefault(userId, observationMode) {
      return identityRepository.setSniperObservationDefault(userId, observationMode);
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

    async previewAccountMerge(input) {
      const normalized = normalizeMergeInput(input);
      const plan = await withMergeValidation(() => identityRepository.previewAccountMerge(normalized));
      // A read-only preview is evidence for an administrator, never an authorization token. The
      // future executor must re-plan inside its own transaction and compare the digest.
      return {
        ...plan,
        executable: false,
        previewOnly: true,
        executionAvailable: false,
        limitedEmptyMergeAvailable: limitedEmptyMergeAvailable(plan),
      };
    },

    async executeAccountMerge(actorUserId, input) {
      const request = mergeExecutionInput(actorUserId, input);
      if (!identityRepository.executeAccountMerge) {
        throw new ValidationError({ field: 'merge', message: 'account merge execution is unavailable' });
      }
      const result = await identityRepository.executeAccountMerge(request);
      if (!result.replayed) {
        // The database commit is already durable. Runtime refresh and socket teardown are required,
        // but a process-local notification problem must never make the UI report that the atomic
        // merge failed and invite an unsafe second attempt.
        try { await onAccountMergeCommitted?.(result); } catch {}
        try { broadcast?.(result.targetUserId, { type: 'identity.changed' }); } catch {}
      }
      return result;
    },

    // Owner-only (gated by the caller, same as every other admin action): repoints a platform
    // identity that ended up on its own separate account -- because both platforms auto-create one
    // on first contact, before ever using a link code -- onto an existing account, and removes the
    // empty duplicate. Refuses and changes nothing if the duplicate has any real data; see
    // postgresIdentityRepository.mergeAccount for the exact emptiness check.
    async mergeAccount(input) {
      const normalized = normalizeMergeInput(input);
      return withMergeValidation(async () => {
        const result=await identityRepository.mergeAccount(normalized);
        // The repository commit is already durable at this point. Refresh every open retained
        // dashboard so its Linked platforms view changes without a hard reload.
        // Notification is best-effort after the database commit. A socket can close between its
        // ready-state check and send; that must never turn a completed merge into a reported failure.
        try{broadcast?.(result.targetUserId,{type:'identity.changed'});}catch{}
        return result;
      });
    },
  };
}

module.exports = {
  DEFAULT_LINK_TTL_MS, LinkCodeError, createIdentityService, hashCode,
  _internal: { mergeExecutionInput },
};
