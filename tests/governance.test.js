const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminCommandService } = require('../src/governance/adminCommandService');
const { AccountBlockedError, AuthorizationError, createGovernanceService } = require('../src/governance/governanceService');
const { ValidationError } = require('../src/validation/domain');
const { applyGovernance } = require('../src/transactions/policyRepository');

function nonOwnerFixture() {
  const repository = {
    isOwner: async () => false,
    findUserByPlatform: async () => 'target-user',
  };
  return createAdminCommandService(createGovernanceService(repository));
}

function ownerFixture({ findUserByPlatform = async () => 'target-user' } = {}) {
  const repository = { isOwner: async () => true, isRootOwner: async () => true, findUserByPlatform };
  return createAdminCommandService(createGovernanceService(repository));
}

test('a non-owner cannot execute any admin input', async () => {
  const commands = [
    'group-set Standard 1 2 3 forced',
    'group-delete Standard',
    'assign telegram 123 Standard',
    'unassign telegram 123',
    'user-ceilings telegram 123 1 2 3',
    'user-ceilings-clear telegram 123',
    'user-simulation telegram 123 optional',
    'group-simulation Standard optional',
    'preset-set safe on 12 on',
    'owner telegram 123 on',
    'unknown-action',
    '',
  ];
  const admin = nonOwnerFixture();
  for (const command of commands) {
    await assert.rejects(admin.execute('regular-user', command), error => error instanceof AuthorizationError && error.code === 'OWNER_REQUIRED');
  }
});

test('an owner who mistypes an admin command gets a ValidationError with a specific, safe-to-show reason instead of a generic failure', async () => {
  const admin = ownerFixture();
  await assert.rejects(admin.execute('owner-user', ''),
    error => error instanceof ValidationError && error.issues[0].field === 'action');
  await assert.rejects(admin.execute('owner-user', 'not-a-real-action foo bar'),
    error => error instanceof ValidationError && error.issues[0].field === 'action' && /not-a-real-action/.test(error.issues[0].message));
  await assert.rejects(admin.execute('owner-user', 'owner telegram 123456789 true'),
    error => error instanceof ValidationError && error.issues[0].field === 'enabled');
  await assert.rejects(admin.execute('owner-user', 'owner martian 123456789 on'),
    error => error instanceof ValidationError && error.issues[0].field === 'platform');
});

test('targeting a platform ID with no linked GhostMint account surfaces a ValidationError, not a generic failure', async () => {
  const admin = ownerFixture({ findUserByPlatform: async () => null });
  await assert.rejects(admin.execute('owner-user', 'owner telegram 123456789 on'),
    error => error instanceof ValidationError && error.issues[0].field === 'platformUserId');
});

// Regression test, at the governanceService layer directly (independent of dashboard/api.js's own
// adminInput check): a group name is one positional token among several in the shared command
// syntax every platform funnels through, unlike a free-text reason. This is defense-in-depth for any
// caller that reaches governanceService directly rather than through the command-string round-trip.
test('a group name containing whitespace is rejected at every group-name entry point in governanceService', async () => {
  const repository = { isOwner: async () => true, findUserByPlatform: async () => 'target-user-id' };
  const governance = createGovernanceService(repository);
  const rejectsOnName = value => error => error instanceof ValidationError && /must not contain spaces/.test(error.issues[0].message) && value(error);

  await assert.rejects(
    governance.upsertGroup('owner-user', { name: 'VIP Members', maxTransactionValueWei: '1', dailySpendingBudgetWei: '2', gasCeilingGwei: '3' }),
    rejectsOnName(error => error.issues[0].field === 'name'));
  await assert.rejects(governance.deleteGroup('owner-user', 'VIP Members'),
    rejectsOnName(error => error.issues[0].field === 'name'));
  await assert.rejects(governance.assignGroup('owner-user', { platform: 'telegram', platformUserId: '123', groupName: 'VIP Members' }),
    rejectsOnName(error => error.issues[0].field === 'groupName'));
  await assert.rejects(governance.setGroupSimulation('owner-user', { groupName: 'VIP Members', simulationForced: 'forced' }),
    rejectsOnName(error => error.issues[0].field === 'groupName'));
  await assert.rejects(governance.setGroupRetentionPolicy('owner-user', { groupName: 'VIP Members', retentionPeriodDays: 'off' }),
    rejectsOnName(error => error.issues[0].field === 'groupName'));

  // A hyphenated name is not itself the problem -- only the space is.
  const okRepository = { isOwner: async () => true, upsertGroup: async value => value };
  await assert.doesNotReject(createGovernanceService(okRepository).upsertGroup('owner-user',
    { name: 'VIP-Members', maxTransactionValueWei: '1', dailySpendingBudgetWei: '2', gasCeilingGwei: '3', simulationForced: 'forced' }));
});

test('a valid owner grant command succeeds end to end once the syntax and target are correct', async () => {
  const calls = [];
  const admin = createAdminCommandService(createGovernanceService({
    isOwner: async () => true,
    isRootOwner: async () => true,
    findUserByPlatform: async () => 'target-user',
    setOwner: async (userId, enabled) => { calls.push({ userId, enabled }); },
  }));
  const result = await admin.execute('owner-user', 'owner telegram 123456789 on');
  assert.deepEqual(calls, [{ userId: 'target-user', enabled: true }]);
  assert.equal(result, 'Owner status updated.');
});

// ── Milestone 16a: account lifecycle ──

function accountRepository(overrides = {}) {
  const statuses = new Map();
  return {
    isOwner: async () => true,
    isRootOwner: async () => false,
    findUserByPlatform: async () => 'target-user',
    getAccountStatus: async userId => statuses.get(userId) || { status: 'active', reason: null, suspendedUntil: null, isOwner: false },
    setAccountStatus: async (userId, { status, reason, suspendedUntil }) => {
      const record = { status, reason, suspendedUntil, isOwner: false };
      statuses.set(userId, record);
      return { user_id: userId, account_status: status, status_reason: reason, suspended_until: suspendedUntil };
    },
    autoReinstateIfExpired: async () => false,
    _statuses: statuses,
    ...overrides,
  };
}

test('an owner can ban, suspend, deactivate, and reinstate a linked account, each requiring a reason', async () => {
  const repository = accountRepository();
  const admin = createAdminCommandService(createGovernanceService(repository));

  await assert.rejects(admin.execute('owner-user', 'ban telegram 123456789'),
    error => error instanceof ValidationError && error.issues[0].field === 'reason');

  await admin.execute('owner-user', 'ban telegram 123456789 spamming other users');
  assert.equal(repository._statuses.get('target-user').status, 'banned');
  assert.equal(repository._statuses.get('target-user').reason, 'spamming other users');

  await admin.execute('owner-user', 'unban telegram 123456789 appeal accepted');
  assert.equal(repository._statuses.get('target-user').status, 'active');

  await admin.execute('owner-user', 'deactivate telegram 123456789 user requested removal');
  assert.equal(repository._statuses.get('target-user').status, 'deactivated');

  await admin.execute('owner-user', 'reactivate telegram 123456789 user came back');
  assert.equal(repository._statuses.get('target-user').status, 'active');
});

test('suspend accepts a duration in days or "indefinite", and rejects a nonsense duration', async () => {
  const repository = accountRepository();
  const admin = createAdminCommandService(createGovernanceService(repository));

  await admin.execute('owner-user', 'suspend telegram 123456789 7 cooling off period');
  const timed = repository._statuses.get('target-user');
  assert.equal(timed.status, 'suspended');
  assert.ok(timed.suspendedUntil instanceof Date);
  assert.ok(timed.suspendedUntil.getTime() > Date.now());

  await admin.execute('owner-user', 'suspend telegram 123456789 indefinite under investigation');
  const indefinite = repository._statuses.get('target-user');
  assert.equal(indefinite.status, 'suspended');
  assert.equal(indefinite.suspendedUntil, null);

  await assert.rejects(admin.execute('owner-user', 'suspend telegram 123456789 not-a-number bad input'),
    error => error instanceof ValidationError && error.issues[0].field === 'durationDays');
});

test('an owner account can never be banned, suspended, or deactivated -- owner status must be removed first', async () => {
  const repository = accountRepository({
    getAccountStatus: async () => ({ status: 'active', reason: null, suspendedUntil: null, isOwner: true }),
  });
  const admin = createAdminCommandService(createGovernanceService(repository));
  await assert.rejects(admin.execute('owner-user', 'ban telegram 123456789 testing the invariant'),
    error => error instanceof ValidationError && error.issues[0].field === 'platformUserId' && /owner/i.test(error.issues[0].message));
});

test('checkAccountStatus is a no-op for an active user, throws AccountBlockedError otherwise, and bypasses owners', async () => {
  const reinstated = [];
  const repository = {
    autoReinstateIfExpired: async userId => { reinstated.push(userId); return false; },
    getAccountStatus: async userId => ({
      active: { status: 'active', reason: null, isOwner: false },
      banned: { status: 'banned', reason: 'spam', isOwner: false },
      suspended: { status: 'suspended', reason: 'cool off', isOwner: false },
      'owner-but-flagged': { status: 'banned', reason: 'should never happen', isOwner: true },
    }[userId]),
  };
  const governance = createGovernanceService(repository);

  await governance.checkAccountStatus('active');
  assert.deepEqual(reinstated, ['active']);

  await assert.rejects(governance.checkAccountStatus('banned'),
    error => error instanceof AccountBlockedError && error.status === 'banned' && error.reason === 'spam');
  await assert.rejects(governance.checkAccountStatus('suspended'),
    error => error instanceof AccountBlockedError && error.status === 'suspended');

  // Defense in depth: even if an owner's status were somehow non-active, they are never blocked.
  await governance.checkAccountStatus('owner-but-flagged');
});

test('subscription and good-standing flags are owner-settable on/off toggles', async () => {
  const calls = [];
  const repository = {
    isOwner: async () => true,
    findUserByPlatform: async () => 'target-user',
    setSubscriptionActive: async (userId, active) => calls.push(['subscription', userId, active]),
    setGoodStandingOverride: async (userId, enabled) => calls.push(['good-standing', userId, enabled]),
  };
  const admin = createAdminCommandService(createGovernanceService(repository));
  await admin.execute('owner-user', 'subscription telegram 123456789 on');
  await admin.execute('owner-user', 'good-standing telegram 123456789 off');
  assert.deepEqual(calls, [['subscription', 'target-user', true], ['good-standing', 'target-user', false]]);
  await assert.rejects(admin.execute('owner-user', 'subscription telegram 123456789 maybe'),
    error => error instanceof ValidationError && error.issues[0].field === 'active');
});

// ── Milestone 16b: governance-group retention scheduling ──

test('group retention policy accepts "off" to disable a period/activity requirement and a positive integer otherwise', async () => {
  const calls = [];
  const repository = {
    isOwner: async () => true,
    setGroupRetentionPolicy: async (name, policy) => calls.push([name, policy]),
  };
  const admin = createAdminCommandService(createGovernanceService(repository));
  await admin.execute('owner-user', 'group-retention VIP 30 on 14');
  await admin.execute('owner-user', 'group-retention VIP off off off');
  assert.deepEqual(calls, [
    ['VIP', { retentionPeriodDays: 30, requireActiveSubscription: true, requireRecentActivityDays: 14 }],
    ['VIP', { retentionPeriodDays: null, requireActiveSubscription: false, requireRecentActivityDays: null }],
  ]);
});

test('scheduling removal for a user with no group assignment surfaces a ValidationError, not a generic failure', async () => {
  const repository = {
    isOwner: async () => true,
    findUserByPlatform: async () => 'target-user',
    scheduleRemoval: async () => { throw new Error('User is not assigned to a group'); },
  };
  const admin = createAdminCommandService(createGovernanceService(repository));
  await assert.rejects(admin.execute('owner-user', 'schedule-removal telegram 123456789 30'),
    error => error instanceof ValidationError && error.issues[0].field === 'platformUserId');
});

const basePolicy = {
  simulationEnabled: false,
  gasCeilingGwei: 100,
  maxTransactionValueWei: 1000n,
  dailySpendingBudgetWei: 2000n,
  requiredConfirmations: 1,
  transactionTimeoutMs: 60_000,
};

test('regular-user ceilings always constrain the selected preset policy', () => {
  const effective = applyGovernance(basePolicy, {
    isOwner: false,
    maxTransactionValueWei: 100n,
    dailySpendingBudgetWei: 200n,
    gasCeilingGwei: 10,
    simulationForced: false,
    preset: { simulationMode: 'off', confirmationCount: 1, humanVerification: 'bypass' },
  });
  assert.equal(effective.maxTransactionValueWei, 100n);
  assert.equal(effective.dailySpendingBudgetWei, 200n);
  assert.equal(effective.gasCeilingGwei, 10);
});

test('forced simulation overrides presets and direct settings', () => {
  for (const preset of [null, { simulationMode: 'off', confirmationCount: 1, humanVerification: 'bypass' }]) {
    const effective = applyGovernance(basePolicy, {
      isOwner: false, maxTransactionValueWei: 1000n, dailySpendingBudgetWei: 2000n,
      gasCeilingGwei: 100, simulationForced: true, preset,
    }, 'blockchain');
    assert.equal(effective.simulationEnabled, true);
  }
});

test('owners are marked ceiling-exempt without disabling other safety settings', () => {
  const effective = applyGovernance(basePolicy, {
    isOwner: true, maxTransactionValueWei: 1n, dailySpendingBudgetWei: 1n,
    gasCeilingGwei: 1, simulationForced: true,
    preset: { simulationMode: 'off', confirmationCount: 3, humanVerification: 'on' },
  });
  assert.equal(effective.ceilingExempt, true);
  assert.equal(effective.simulationEnabled, true);
  assert.equal(effective.requiredConfirmations, 3);
});
