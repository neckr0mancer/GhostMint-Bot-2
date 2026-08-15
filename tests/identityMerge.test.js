const assert = require('node:assert/strict');
const test = require('node:test');
const { createIdentityService } = require('../src/identity/identityService');
const { createAdminCommandService } = require('../src/governance/adminCommandService');
const { createGovernanceService } = require('../src/governance/governanceService');
const { ValidationError } = require('../src/validation/domain');

function repositoryStub(overrides = {}) {
  return {
    mergeAccount: async () => { throw new Error('mergeAccount not stubbed'); },
    ...overrides,
  };
}

test('mergeAccount validates platform and forwards normalized identities to the repository', async () => {
  const calls = [];
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async input => { calls.push(input); return { sourceUserId: 'src', targetUserId: 'tgt' }; },
  }));
  const result = await identity.mergeAccount({
    sourcePlatform: 'Discord', sourcePlatformUserId: ' 123 ',
    targetPlatform: 'TELEGRAM', targetPlatformUserId: '456',
  });
  assert.deepEqual(calls, [{
    sourcePlatform: 'discord', sourcePlatformUserId: '123',
    targetPlatform: 'telegram', targetPlatformUserId: '456',
  }]);
  assert.deepEqual(result, { sourceUserId: 'src', targetUserId: 'tgt' });

  await assert.rejects(identity.mergeAccount({
    sourcePlatform: 'martian', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '2',
  }), /Unsupported identity platform/);
});

test('mergeAccount translates every repository refusal code into a ValidationError with a safe message', async () => {
  const cases = [
    ['SOURCE_NOT_FOUND', 'sourcePlatformUserId'],
    ['TARGET_NOT_FOUND', 'targetPlatformUserId'],
    ['SAME_ACCOUNT', 'targetPlatformUserId'],
    ['ACCOUNT_NOT_EMPTY', 'sourcePlatformUserId'],
  ];
  for (const [code, field] of cases) {
    const identity = createIdentityService(repositoryStub({
      mergeAccount: async () => { const error = new Error(`${code} message`); error.code = code; throw error; },
    }));
    await assert.rejects(
      identity.mergeAccount({ sourcePlatform: 'discord', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '2' }),
      error => error instanceof ValidationError && error.issues[0].field === field && error.issues[0].message === `${code} message`,
    );
  }
});

test('mergeAccount lets an unrecognized/unexpected repository error pass through unchanged', async () => {
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async () => { throw new Error('connection reset'); },
  }));
  await assert.rejects(
    identity.mergeAccount({ sourcePlatform: 'discord', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '2' }),
    error => !(error instanceof ValidationError) && error.message === 'connection reset',
  );
});

// ── adminCommandService dispatch ──

function ownerGovernance() {
  return createGovernanceService({ isOwner: async () => true });
}

test('a non-owner cannot reach merge-account even with a valid identity service wired in', async () => {
  const governance = createGovernanceService({ isOwner: async () => false });
  const identity = createIdentityService(repositoryStub({ mergeAccount: async () => { throw new Error('must not be called'); } }));
  const admin = createAdminCommandService(governance, identity);
  await assert.rejects(admin.execute('regular-user', 'merge-account discord 111 telegram 222'),
    error => error.code === 'OWNER_REQUIRED');
});

test('an owner running merge-account dispatches to identity.mergeAccount with the four positional args', async () => {
  const calls = [];
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async input => { calls.push(input); return { sourceUserId: 'src-uuid', targetUserId: 'tgt-uuid' }; },
  }));
  const admin = createAdminCommandService(ownerGovernance(), identity);
  const message = await admin.execute('owner-user', 'merge-account discord 111 telegram 222');
  assert.deepEqual(calls, [{ sourcePlatform: 'discord', sourcePlatformUserId: '111', targetPlatform: 'telegram', targetPlatformUserId: '222' }]);
  assert.match(message, /Merged discord:111 into account tgt-uuid/);
});

test('merge-account surfaces the identity service ValidationError instead of a generic failure', async () => {
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async () => { const error = new Error('has 2 wallet(s)'); error.code = 'ACCOUNT_NOT_EMPTY'; throw error; },
  }));
  const admin = createAdminCommandService(ownerGovernance(), identity);
  await assert.rejects(admin.execute('owner-user', 'merge-account discord 111 telegram 222'),
    error => error instanceof ValidationError && error.issues[0].field === 'sourcePlatformUserId' && /wallet/.test(error.issues[0].message));
});

test('merge-account is rejected safely (not a crash) when no identity service was wired in', async () => {
  const admin = createAdminCommandService(ownerGovernance());
  await assert.rejects(admin.execute('owner-user', 'merge-account discord 111 telegram 222'),
    error => error instanceof ValidationError);
});
