const { createHash } = require('node:crypto');

const ACCOUNT_MERGE_PLAN_VERSION = 2;
const ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION = 1;
const ACCOUNT_MERGE_SCHEMA_REVISION = '072_account_merge_ownership_fks.sql';
const ACCOUNT_MERGE_GUARD_DOMAINS = Object.freeze([
  'accountLinkCodes',
  'activity',
  'attemptsReferencingIntents',
  'botSecurityAudit',
  'dashboardSessions',
  'groupRetentionEvents',
  'intentsReferencingWallets',
  'launchSquadMembers',
  'launchSquads',
  'linkedAccounts',
  'liveAcceptanceRuns',
  'liveRunsReferencingIntents',
  'mintPresets',
  'mintTaskAttempts',
  'mintTaskChangeEvents',
  'mintTaskPreflightChecks',
  'mintTasks',
  'mintTasksReferencingIntents',
  'modePresetsUpdated',
  'openSeaEligibilityAuthorizations',
  'pnlRecords',
  'seatGroupsCreated',
  'sniperEventTransitions',
  'sniperEvents',
  'sniperEventsReferencingIntents',
  'snipers',
  'socialAdapterUsage',
  'socialTriggerEvents',
  'socialWatchRules',
  'squadMembersReferencingIntents',
  'targetBypassChallenges',
  'targetTriggerPolicies',
  'transactionBroadcastHashes',
  'transactionIntents',
  'transactionPolicies',
  'transactionStateTransitions',
  'triggerAuditReferencingIntents',
  'triggerExecutionAudit',
  'triggerExecutionRequests',
  'usageReferencingRules',
  'userGovernanceOwned',
  'userGovernanceUpdated',
  'users',
  'userStatusesUpdated',
  'wallets',
]);
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function plainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain object');
  return value;
}

function safeKey(value, path) {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) {
    fail(path, 'must be a safe identifier of at most 64 characters');
  }
  return value;
}

function canonicalize(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite JSON numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const object = plainObject(value, path);
    return Object.fromEntries(Object.keys(object).sort().map(key => {
      if (object[key] === undefined) fail(`${path}.${key}`, 'must not be undefined');
      return [key, canonicalize(object[key], `${path}.${key}`)];
    }));
  }
  fail(path, 'must contain only JSON-safe values');
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function requiredText(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
  return value.trim();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeIdentities(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const normalized = value.map((identity, index) => {
    const item = plainObject(identity, `${path}[${index}]`);
    const platform = requiredText(item.platform, `${path}[${index}].platform`).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(platform)) fail(`${path}[${index}].platform`, 'is invalid');
    return {
      platform,
      platformUserId: requiredText(item.platformUserId, `${path}[${index}].platformUserId`),
    };
  });
  normalized.sort((left, right) => compareText(left.platform, right.platform)
    || compareText(left.platformUserId, right.platformUserId));
  return normalized.filter((identity, index) => index === 0
    || identity.platform !== normalized[index - 1].platform
    || identity.platformUserId !== normalized[index - 1].platformUserId);
}

function normalizeSingletonValues(value, path) {
  const object = value === undefined ? {} : plainObject(value, path);
  return Object.fromEntries(Object.keys(object).sort().flatMap(key => {
    safeKey(key, `${path} key`);
    const setting = object[key];
    if (setting === undefined) fail(`${path}.${key}`, 'must not be undefined');
    // The repository normalizes an unset/default value to null. Treating null and an omitted key
    // identically keeps the snapshot digest semantic instead of serialization-dependent.
    return setting === null ? [] : [[key, canonicalize(setting, `${path}.${key}`)]];
  }));
}

function normalizeAccount(value, path) {
  const account = plainObject(value, path);
  const flags = account.flags === undefined ? {} : plainObject(account.flags, `${path}.flags`);
  for (const key of ['isOwner', 'isRootOwner']) {
    if (flags[key] !== undefined && typeof flags[key] !== 'boolean') {
      fail(`${path}.flags.${key}`, 'must be a boolean');
    }
  }
  return {
    userId: requiredText(account.userId, `${path}.userId`),
    identities: normalizeIdentities(account.identities === undefined ? [] : account.identities,
      `${path}.identities`),
    flags: {
      isOwner: flags.isOwner === true,
      isRootOwner: flags.isRootOwner === true,
    },
    singletonValues: normalizeSingletonValues(account.singletonValues, `${path}.singletonValues`),
  };
}

function normalizeCounts(value, path) {
  const object = value === undefined ? {} : plainObject(value, path);
  return Object.fromEntries(Object.keys(object).sort().flatMap(key => {
    safeKey(key, `${path} key`);
    const count = object[key];
    if (!Number.isSafeInteger(count) || count < 0) fail(`${path}.${key}`, 'must be a non-negative safe integer');
    return count === 0 ? [] : [[key, count]];
  }));
}

function assertExactKeys(object, expected, path) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(path, `must contain exactly: ${wanted.join(', ')}`);
  }
}

function normalizeFingerprintEntry(value, path) {
  const object = plainObject(value, path);
  assertExactKeys(object, ['count', 'fingerprint'], path);
  if (!Number.isSafeInteger(object.count) || object.count < 0) {
    fail(`${path}.count`, 'must be a non-negative safe integer');
  }
  if (typeof object.fingerprint !== 'string' || !SHA256_FINGERPRINT.test(object.fingerprint)) {
    fail(`${path}.fingerprint`, 'must be a sha256 fingerprint');
  }
  return { count: object.count, fingerprint: object.fingerprint };
}

function normalizeFingerprintMap(value, path) {
  const object = plainObject(value, path);
  assertExactKeys(object, ACCOUNT_MERGE_GUARD_DOMAINS, path);
  return Object.fromEntries(ACCOUNT_MERGE_GUARD_DOMAINS.map(key => {
    safeKey(key, `${path} key`);
    return [key, normalizeFingerprintEntry(object[key], `${path}.${key}`)];
  }));
}

function normalizeGuardValues(value, path) {
  const object = plainObject(value, path);
  assertExactKeys(object, ['graphInventoryVersion', 'schemaRevision', 'ownershipGraph'], path);
  if (object.graphInventoryVersion !== ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION) {
    fail(`${path}.graphInventoryVersion`, `must equal ${ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION}`);
  }
  if (object.schemaRevision !== ACCOUNT_MERGE_SCHEMA_REVISION) {
    fail(`${path}.schemaRevision`, `must equal ${ACCOUNT_MERGE_SCHEMA_REVISION}`);
  }
  const graph = plainObject(object.ownershipGraph, `${path}.ownershipGraph`);
  assertExactKeys(graph, ['source', 'target'], `${path}.ownershipGraph`);
  const source = normalizeFingerprintMap(graph.source, `${path}.ownershipGraph.source`);
  const target = normalizeFingerprintMap(graph.target, `${path}.ownershipGraph.target`);
  return {
    graphInventoryVersion: ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
    schemaRevision: ACCOUNT_MERGE_SCHEMA_REVISION,
    ownershipGraph: { source, target },
  };
}

function normalizeSnapshot(snapshot) {
  const value = plainObject(snapshot, 'snapshot');
  const counts = value.counts === undefined ? {} : plainObject(value.counts, 'snapshot.counts');
  return {
    source: normalizeAccount(value.source, 'snapshot.source'),
    target: normalizeAccount(value.target, 'snapshot.target'),
    counts: {
      movable: normalizeCounts(counts.movable, 'snapshot.counts.movable'),
      revocable: normalizeCounts(counts.revocable, 'snapshot.counts.revocable'),
      blocking: normalizeCounts(counts.blocking, 'snapshot.counts.blocking'),
    },
    // Opaque repository-provided row fingerprints/revisions belong in guardValues. Plan v2
    // deliberately requires a complete, versioned source/target graph so a caller cannot create
    // an execution-capable approval from counts alone. The fingerprints take part in the digest,
    // but are never copied into the safe plan returned to callers.
    guardValues: normalizeGuardValues(value.guardValues, 'snapshot.guardValues'),
  };
}

function digestNormalizedSnapshot(normalized) {
  const payload = stableStringify({ planVersion: ACCOUNT_MERGE_PLAN_VERSION, snapshot: normalized });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function digestAccountMergeSnapshot(snapshot) {
  return digestNormalizedSnapshot(normalizeSnapshot(snapshot));
}

function countSummary(counts) {
  const domains = Object.entries(counts).map(([key, count]) => ({ key, count }));
  return { rows: domains.reduce((total, item) => total + item.count, 0), domains };
}

function identitiesByPlatform(identities) {
  const values = new Map();
  for (const identity of identities) {
    if (!values.has(identity.platform)) values.set(identity.platform, new Set());
    values.get(identity.platform).add(identity.platformUserId);
  }
  return values;
}

function singletonSummary(source, target) {
  const takeFromSource = [];
  const keepTarget = [];
  const alreadyEqual = [];
  const choiceRequired = [];
  const keys = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  for (const key of keys) {
    const sourceHas = Object.hasOwn(source, key);
    const targetHas = Object.hasOwn(target, key);
    if (sourceHas && !targetHas) takeFromSource.push(key);
    else if (!sourceHas && targetHas) keepTarget.push(key);
    else if (stableStringify(source[key]) === stableStringify(target[key])) alreadyEqual.push(key);
    else choiceRequired.push(key);
  }
  return { takeFromSource, keepTarget, alreadyEqual, choiceRequired };
}

function buildAccountMergePlan(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const snapshotDigest = digestNormalizedSnapshot(normalized);
  const sourcePlatforms = identitiesByPlatform(normalized.source.identities);
  const targetPlatforms = identitiesByPlatform(normalized.target.identities);
  const singleton = singletonSummary(normalized.source.singletonValues, normalized.target.singletonValues);
  const movable = countSummary(normalized.counts.movable);
  const revocable = countSummary(normalized.counts.revocable);
  const blocking = countSummary(normalized.counts.blocking);
  const summary = {
    sourceIdentityCount: normalized.source.identities.length,
    targetIdentityCount: normalized.target.identities.length,
    identityPlatformsToMove: [...sourcePlatforms.keys()].sort(),
    movable,
    revocable,
    blocking,
    singleton,
  };

  if (normalized.source.userId === normalized.target.userId) {
    return {
      planVersion: ACCOUNT_MERGE_PLAN_VERSION,
      snapshotDigest,
      classification: 'already_unified',
      executable: false,
      sourceUserId: normalized.source.userId,
      targetUserId: normalized.target.userId,
      blockers: [],
      requiredChoices: [],
      summary,
    };
  }

  const blockers = [];
  if (normalized.source.flags.isRootOwner || normalized.source.flags.isOwner) {
    blockers.push({
      code: 'SOURCE_PRIVILEGED',
      category: 'account',
      message: normalized.source.flags.isRootOwner
        ? 'The source account is a root owner and cannot be merged.'
        : 'The source account is an owner and cannot be merged.',
    });
  }
  for (const [platform, values] of [...sourcePlatforms.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    if (values.size > 1) blockers.push({
      code: 'SOURCE_PLATFORM_AMBIGUOUS', category: 'identity', platform,
      message: `The source account has more than one ${platform} identity.`,
    });
  }
  for (const [platform, values] of [...targetPlatforms.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    if (values.size > 1) blockers.push({
      code: 'TARGET_PLATFORM_AMBIGUOUS', category: 'identity', platform,
      message: `The target account has more than one ${platform} identity.`,
    });
  }
  for (const platform of [...sourcePlatforms.keys()].filter(value => targetPlatforms.has(value)).sort()) {
    const sourceIds = sourcePlatforms.get(platform);
    const targetIds = targetPlatforms.get(platform);
    const sameIdentity = sourceIds.size === 1 && targetIds.size === 1
      && [...sourceIds][0] === [...targetIds][0];
    blockers.push({
      code: sameIdentity ? 'IDENTITY_OWNERSHIP_INCONSISTENT' : 'TARGET_PLATFORM_CONFLICT',
      category: 'identity',
      platform,
      message: sameIdentity
        ? `The same ${platform} identity appears on two different accounts.`
        : `The target account already has a different ${platform} identity.`,
    });
  }
  for (const { key, count } of blocking.domains) blockers.push({
    code: 'BLOCKING_ROWS', category: 'data', key, count,
    message: `The source account has ${count} blocking ${key} row${count === 1 ? '' : 's'}.`,
  });

  const requiredChoices = singleton.choiceRequired.map(key => ({
    code: 'SINGLETON_CONFLICT',
    category: 'singleton',
    key,
    options: ['keep_target', 'use_source'],
    message: `Choose which ${key} setting to keep.`,
  }));
  const classification = blockers.length ? 'blocked' : requiredChoices.length ? 'choice_required' : 'ready';
  return {
    planVersion: ACCOUNT_MERGE_PLAN_VERSION,
    snapshotDigest,
    classification,
    executable: classification === 'ready',
    sourceUserId: normalized.source.userId,
    targetUserId: normalized.target.userId,
    blockers,
    requiredChoices,
    summary,
  };
}

module.exports = {
  ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
  ACCOUNT_MERGE_GUARD_DOMAINS,
  ACCOUNT_MERGE_PLAN_VERSION,
  ACCOUNT_MERGE_SCHEMA_REVISION,
  buildAccountMergePlan,
  digestAccountMergeSnapshot,
};
