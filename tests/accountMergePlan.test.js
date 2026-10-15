const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
  ACCOUNT_MERGE_GUARD_DOMAINS,
  ACCOUNT_MERGE_PLAN_VERSION,
  ACCOUNT_MERGE_SCHEMA_REVISION,
  buildAccountMergePlan,
  digestAccountMergeSnapshot,
} = require('../src/identity/accountMergePlan');

function fingerprint(seed) {
  return `sha256:${createHash('sha256').update(seed).digest('hex')}`;
}

function guardValues({ source = {}, target = {}, reverse = false } = {}) {
  const domains = reverse ? [...ACCOUNT_MERGE_GUARD_DOMAINS].reverse() : ACCOUNT_MERGE_GUARD_DOMAINS;
  const side = (name, overrides) => Object.fromEntries(domains.map(domain => [domain, {
    count: 0,
    fingerprint: fingerprint(`${name}:${domain}:empty`),
    ...overrides[domain],
  }]));
  return {
    graphInventoryVersion: ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
    schemaRevision: ACCOUNT_MERGE_SCHEMA_REVISION,
    ownershipGraph: { source: side('source', source), target: side('target', target) },
  };
}

function snapshot(overrides = {}) {
  return {
    source: {
      userId: 'source-user',
      identities: [{ platform: 'discord', platformUserId: 'discord-1' }],
      flags: { isOwner: false, isRootOwner: false },
      singletonValues: {},
      ...overrides.source,
    },
    target: {
      userId: 'target-user',
      identities: [{ platform: 'telegram', platformUserId: 'telegram-1' }],
      flags: { isOwner: false, isRootOwner: false },
      singletonValues: {},
      ...overrides.target,
    },
    counts: { movable: {}, revocable: {}, blocking: {}, ...overrides.counts },
    guardValues: overrides.guardValues || guardValues(),
  };
}

test('snapshot digest is semantic and deterministic across harmless ordering and empty defaults', () => {
  const left = snapshot({
    source: {
      identities: [
        { platform: 'telegram', platformUserId: 'telegram-2' },
        { platform: 'discord', platformUserId: 'discord-1' },
      ],
      singletonValues: { displayName: 'Alice', unsetValue: null, preferences: { z: 2, a: 1 } },
    },
    counts: { movable: { wallets: 2, activity: 0, mintTasks: 3 } },
    guardValues: guardValues(),
  });
  const right = snapshot({
    source: {
      identities: [
        { platform: 'discord', platformUserId: 'discord-1' },
        { platform: 'telegram', platformUserId: 'telegram-2' },
      ],
      singletonValues: { preferences: { a: 1, z: 2 }, displayName: 'Alice' },
    },
    counts: { movable: { mintTasks: 3, wallets: 2 } },
    guardValues: guardValues({ reverse: true }),
  });
  assert.equal(digestAccountMergeSnapshot(left), digestAccountMergeSnapshot(right));
  assert.match(digestAccountMergeSnapshot(left), /^sha256:[a-f0-9]{64}$/);
});

test('digest changes when a hidden plan-relevant value or repository guard changes', () => {
  const original = snapshot({
    source: { singletonValues: { securityPasswordHash: 'secret-hash-a' } },
    guardValues: guardValues(),
  });
  const settingChanged = snapshot({
    source: { singletonValues: { securityPasswordHash: 'secret-hash-b' } },
    guardValues: guardValues(),
  });
  const guardChanged = snapshot({
    source: { singletonValues: { securityPasswordHash: 'secret-hash-a' } },
    guardValues: guardValues({ source: {
      wallets: { count: 1, fingerprint: fingerprint('source:wallets:changed') },
    } }),
  });
  assert.notEqual(digestAccountMergeSnapshot(original), digestAccountMergeSnapshot(settingChanged));
  assert.notEqual(digestAccountMergeSnapshot(original), digestAccountMergeSnapshot(guardChanged));
  const serialized = JSON.stringify(buildAccountMergePlan(original));
  assert.doesNotMatch(serialized, /secret-hash|ownershipGraph|fingerprint/,
    'safe plan output must never copy singleton values or opaque guards');
});

test('ready plan summarizes move, revocation, and non-conflicting singleton decisions without values', () => {
  const plan = buildAccountMergePlan(snapshot({
    source: { singletonValues: { displayName: 'Source name', timeFormat: '24h' } },
    target: { singletonValues: { defaultChain: 'base', timeFormat: '24h' } },
    counts: {
      movable: { wallets: 2, activity: 5 },
      revocable: { dashboardSessions: 1, accountLinkCodes: 2 },
    },
  }));
  assert.equal(plan.planVersion, ACCOUNT_MERGE_PLAN_VERSION);
  assert.equal(plan.classification, 'ready');
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.requiredChoices, []);
  assert.deepEqual(plan.summary.identityPlatformsToMove, ['discord']);
  assert.deepEqual(plan.summary.movable, {
    rows: 7,
    domains: [{ key: 'activity', count: 5 }, { key: 'wallets', count: 2 }],
  });
  assert.deepEqual(plan.summary.revocable, {
    rows: 3,
    domains: [{ key: 'accountLinkCodes', count: 2 }, { key: 'dashboardSessions', count: 1 }],
  });
  assert.deepEqual(plan.summary.singleton, {
    takeFromSource: ['displayName'],
    keepTarget: ['defaultChain'],
    alreadyEqual: ['timeFormat'],
    choiceRequired: [],
  });
  assert.doesNotMatch(JSON.stringify(plan), /Source name|base|24h/);
});

test('differing populated singleton values require an explicit source-or-target choice', () => {
  const plan = buildAccountMergePlan(snapshot({
    source: { singletonValues: { displayName: 'Source', defaultChain: 'ethereum' } },
    target: { singletonValues: { displayName: 'Target', defaultChain: 'base' } },
  }));
  assert.equal(plan.classification, 'choice_required');
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.summary.singleton.choiceRequired, ['defaultChain', 'displayName']);
  assert.deepEqual(plan.requiredChoices, [
    {
      code: 'SINGLETON_CONFLICT', category: 'singleton', key: 'defaultChain',
      options: ['keep_target', 'use_source'], message: 'Choose which defaultChain setting to keep.',
    },
    {
      code: 'SINGLETON_CONFLICT', category: 'singleton', key: 'displayName',
      options: ['keep_target', 'use_source'], message: 'Choose which displayName setting to keep.',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(plan), /\"Source\"|\"Target\"|\"ethereum\"|\"base\"/);
});

test('privilege, identity collisions, and repository-classified rows are hard blockers', () => {
  const plan = buildAccountMergePlan(snapshot({
    source: {
      flags: { isOwner: true, isRootOwner: false },
      identities: [
        { platform: 'discord', platformUserId: 'discord-source' },
        { platform: 'telegram', platformUserId: 'telegram-source' },
      ],
    },
    target: {
      identities: [
        { platform: 'discord', platformUserId: 'discord-target' },
        { platform: 'telegram', platformUserId: 'telegram-target' },
      ],
    },
    counts: { blocking: { activeMintTasks: 2 } },
  }));
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.blockers.map(value => [value.code, value.platform || value.key || null]), [
    ['SOURCE_PRIVILEGED', null],
    ['TARGET_PLATFORM_CONFLICT', 'discord'],
    ['TARGET_PLATFORM_CONFLICT', 'telegram'],
    ['BLOCKING_ROWS', 'activeMintTasks'],
  ]);
  assert.equal(plan.summary.blocking.rows, 2);
});

test('same account is an idempotent already-unified plan even when snapshots use different identities', () => {
  const plan = buildAccountMergePlan(snapshot({
    source: { userId: 'one-user' },
    target: { userId: 'one-user' },
  }));
  assert.equal(plan.classification, 'already_unified');
  assert.equal(plan.executable, false);
  assert.equal(plan.sourceUserId, 'one-user');
  assert.equal(plan.targetUserId, 'one-user');
  assert.deepEqual(plan.blockers, []);
});

test('the same platform identity on different users is classified as corrupt ownership without exposing the ID', () => {
  const plan = buildAccountMergePlan(snapshot({
    source: { identities: [{ platform: 'discord', platformUserId: 'private-id' }] },
    target: { identities: [{ platform: 'discord', platformUserId: 'private-id' }] },
  }));
  assert.equal(plan.classification, 'blocked');
  assert.equal(plan.blockers[0].code, 'IDENTITY_OWNERSHIP_INCONSISTENT');
  assert.doesNotMatch(JSON.stringify(plan), /private-id/);
});

test('malformed repository snapshots fail closed', () => {
  assert.throws(() => buildAccountMergePlan(snapshot({ counts: { movable: { wallets: -1 } } })),
    /non-negative safe integer/);
  assert.throws(() => buildAccountMergePlan(snapshot({ guardValues: { bad: undefined } })),
    /must contain exactly/);
  const missingDomain = guardValues();
  delete missingDomain.ownershipGraph.source.wallets;
  assert.throws(() => buildAccountMergePlan(snapshot({ guardValues: missingDomain })),
    /must contain exactly/);
  const unknownDomain = guardValues();
  unknownDomain.ownershipGraph.target.unknownRows = {
    count: 0, fingerprint: fingerprint('unknown'),
  };
  assert.throws(() => buildAccountMergePlan(snapshot({ guardValues: unknownDomain })),
    /must contain exactly/);
  const malformedFingerprint = guardValues();
  malformedFingerprint.ownershipGraph.source.wallets.fingerprint = 'not-a-hash';
  assert.throws(() => buildAccountMergePlan(snapshot({ guardValues: malformedFingerprint })),
    /must be a sha256 fingerprint/);
  const malformedCount = guardValues();
  malformedCount.ownershipGraph.target.wallets.count = -1;
  assert.throws(() => buildAccountMergePlan(snapshot({ guardValues: malformedCount })),
    /non-negative safe integer/);
  assert.throws(() => buildAccountMergePlan(snapshot({ source: { userId: ' ' } })),
    /source\.userId must be a non-empty string/);
  assert.throws(() => buildAccountMergePlan(snapshot({ source: { flags: { isOwner: 'true' } } })),
    /flags\.isOwner must be a boolean/);
  assert.throws(() => buildAccountMergePlan(snapshot({ source: { identities: null } })),
    /identities must be an array/);
});

test('plan v3 changes when either ownership side changes without exposing private graph guards', () => {
  assert.equal(ACCOUNT_MERGE_PLAN_VERSION, 3);
  assert.equal(ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION, 2);
  assert.equal(ACCOUNT_MERGE_SCHEMA_REVISION, '073_wallet_history_foundation.sql');
  for (const domain of ['walletHistorySubjects', 'walletHistorySyncState',
    'walletHistoryTransactions', 'walletHistoryMovements']) {
    assert.equal(ACCOUNT_MERGE_GUARD_DOMAINS.includes(domain), true);
  }
  const original = snapshot();
  const sourceChanged = snapshot({ guardValues: guardValues({ source: {
    mintTaskAttempts: { count: 1, fingerprint: fingerprint('source-attempt-update') },
  } }) });
  const targetChanged = snapshot({ guardValues: guardValues({ target: {
    transactionStateTransitions: { count: 1, fingerprint: fingerprint('target-transition-insert') },
  } }) });
  assert.notEqual(digestAccountMergeSnapshot(original), digestAccountMergeSnapshot(sourceChanged));
  assert.notEqual(digestAccountMergeSnapshot(original), digestAccountMergeSnapshot(targetChanged));
  const serialized = JSON.stringify(buildAccountMergePlan(sourceChanged));
  assert.doesNotMatch(serialized, /ownershipGraph|source-attempt-update|fingerprint/);
});
