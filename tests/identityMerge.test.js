const assert = require('node:assert/strict');
const test = require('node:test');
const { createIdentityService, _internal: identityInternals } = require('../src/identity/identityService');
const { createAdminCommandService } = require('../src/governance/adminCommandService');
const { createGovernanceService } = require('../src/governance/governanceService');
const { ValidationError } = require('../src/validation/domain');

function repositoryStub(overrides = {}) {
  return {
    previewAccountMerge: async () => { throw new Error('previewAccountMerge not stubbed'); },
    executeAccountMerge: async () => { throw new Error('executeAccountMerge not stubbed'); },
    mergeAccount: async () => { throw new Error('mergeAccount not stubbed'); },
    ...overrides,
  };
}

test('previewAccountMerge validates identities and remains read-only at the service boundary', async () => {
  const calls = [];
  const broadcasts = [];
  const plan = {
    classification: 'blocked', executable: true, sourceUserId: 'src', targetUserId: 'tgt',
    summary: {
      sourceIdentityCount: 1,
      movable: { rows: 1, domains: [{ key: 'wallets', count: 1 }] },
      revocable: { rows: 0, domains: [] },
      blocking: { rows: 0, domains: [] },
    },
  };
  const identity = createIdentityService(repositoryStub({
    previewAccountMerge: async input => { calls.push(input); return plan; },
  }), { broadcast: (...args) => broadcasts.push(args) });
  assert.deepEqual(await identity.previewAccountMerge({
    sourcePlatform: ' Discord ', sourcePlatformUserId: ' 123 ',
    targetPlatform: 'TELEGRAM', targetPlatformUserId: ' 456 ',
  }), {
    ...plan, executable: false, previewOnly: true, executionAvailable: false,
    limitedEmptyMergeAvailable: false,
  });
  assert.deepEqual(calls, [{
    sourcePlatform: 'discord', sourcePlatformUserId: '123',
    targetPlatform: 'telegram', targetPlatformUserId: '456',
  }]);
  assert.deepEqual(broadcasts, [], 'a preview must not announce a state change');
});

test('previewAccountMerge exposes the limited executor only for its exact empty-account contract', async () => {
  const basePlan = {
    classification: 'ready', executable: true, sourceUserId: 'src', targetUserId: 'tgt',
    summary: {
      sourceIdentityCount: 1,
      movable: { rows: 0, domains: [] },
      blocking: { rows: 0, domains: [] },
      revocable: { rows: 1, domains: [{ key: 'accountLinkCodes', count: 1 }] },
    },
  };
  let nextPlan = basePlan;
  const identity = createIdentityService(repositoryStub({
    previewAccountMerge: async () => nextPlan,
  }));
  const input = {
    sourcePlatform: 'discord', sourcePlatformUserId: '123',
    targetPlatform: 'telegram', targetPlatformUserId: '456',
  };
  assert.equal((await identity.previewAccountMerge(input)).limitedEmptyMergeAvailable, true);
  nextPlan = {
    ...basePlan,
    summary: {
      ...basePlan.summary,
      revocable: { rows: 1, domains: [{ key: 'targetBypassChallenges', count: 1 }] },
    },
  };
  assert.equal((await identity.previewAccountMerge(input)).limitedEmptyMergeAvailable, false);
});

test('previewAccountMerge maps expected lookup failures to safe validation fields', async () => {
  const identity = createIdentityService(repositoryStub({
    previewAccountMerge: async () => { const error = new Error('No linked source account found'); error.code = 'SOURCE_NOT_FOUND'; throw error; },
  }));
  await assert.rejects(identity.previewAccountMerge({
    sourcePlatform: 'discord', sourcePlatformUserId: '123',
    targetPlatform: 'telegram', targetPlatformUserId: '456',
  }), error => error instanceof ValidationError
    && error.issues[0].field === 'sourcePlatformUserId'
    && error.issues[0].message === 'No linked source account found');
});

test('account merge input errors are safe validation failures before repository access', async () => {
  let calls = 0;
  const identity = createIdentityService(repositoryStub({
    previewAccountMerge: async () => { calls += 1; },
    executeAccountMerge: async () => { calls += 1; },
  }));
  const previewCases = [
    [{ sourcePlatform: 'email', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '2' }, 'sourcePlatform'],
    [{ sourcePlatform: 'discord', sourcePlatformUserId: '', targetPlatform: 'telegram', targetPlatformUserId: '2' }, 'sourcePlatformUserId'],
    [{ sourcePlatform: 'discord', sourcePlatformUserId: '1', targetPlatform: 'email', targetPlatformUserId: '2' }, 'targetPlatform'],
    [{ sourcePlatform: 'discord', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '' }, 'targetPlatformUserId'],
  ];
  for (const [input, field] of previewCases) {
    await assert.rejects(identity.previewAccountMerge(input), error =>
      error instanceof ValidationError && error.issues[0].field === field);
  }
  await assert.rejects(identity.executeAccountMerge(ACTOR_USER_ID, {
    ...executionInput(), sourcePlatform: 'email',
  }), error => error instanceof ValidationError && error.issues[0].field === 'sourcePlatform');
  assert.equal(calls, 0);
});

test('mergeAccount validates platform and forwards normalized identities to the repository', async () => {
  const calls = [];
  const broadcasts=[];
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async input => { calls.push(input); return { sourceUserId: 'src', targetUserId: 'tgt' }; },
  }),{broadcast:(userId,message)=>broadcasts.push({userId,message})});
  const result = await identity.mergeAccount({
    sourcePlatform: 'Discord', sourcePlatformUserId: ' 123 ',
    targetPlatform: 'TELEGRAM', targetPlatformUserId: '456',
  });
  assert.deepEqual(calls, [{
    sourcePlatform: 'discord', sourcePlatformUserId: '123',
    targetPlatform: 'telegram', targetPlatformUserId: '456',
  }]);
  assert.deepEqual(result, { sourceUserId: 'src', targetUserId: 'tgt' });
  assert.deepEqual(broadcasts,[{userId:'tgt',message:{type:'identity.changed'}}]);

  await assert.rejects(identity.mergeAccount({
    sourcePlatform: 'martian', sourcePlatformUserId: '1', targetPlatform: 'telegram', targetPlatformUserId: '2',
  }), error => error instanceof ValidationError
    && error.issues[0].field === 'sourcePlatform'
    && error.issues[0].message === 'must be telegram or discord');
});

test('a post-commit dashboard notification failure never makes a completed merge look failed',async()=>{
  const identity=createIdentityService(repositoryStub({
    mergeAccount:async()=>({sourceUserId:'src',targetUserId:'tgt'}),
  }),{broadcast:()=>{throw new Error('socket closed');}});
  assert.deepEqual(await identity.mergeAccount({
    sourcePlatform:'discord',sourcePlatformUserId:'1',targetPlatform:'telegram',targetPlatformUserId:'2',
  }),{sourceUserId:'src',targetUserId:'tgt'});
});

test('mergeAccount translates every repository refusal code into a ValidationError with a safe message', async () => {
  const cases = [
    ['SOURCE_NOT_FOUND', 'sourcePlatformUserId'],
    ['TARGET_NOT_FOUND', 'targetPlatformUserId'],
    ['SAME_ACCOUNT', 'targetPlatformUserId'],
    ['TARGET_PLATFORM_CONFLICT', 'targetPlatformUserId'],
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

const ACTOR_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_DIGEST = `sha256:${'d'.repeat(64)}`;

function executionInput(overrides = {}) {
  return {
    sourcePlatform: 'Discord',
    sourcePlatformUserId: ' 111 ',
    targetPlatform: 'TELEGRAM',
    targetPlatformUserId: ' 222 ',
    expectedSourceUserId: SOURCE_USER_ID.toUpperCase(),
    expectedTargetUserId: TARGET_USER_ID.toUpperCase(),
    expectedPlanVersion: 2,
    expectedSnapshotDigest: SNAPSHOT_DIGEST,
    resolutionMap: {},
    confirmationText: `MERGE ${SOURCE_USER_ID} INTO ${TARGET_USER_ID}`,
    ...overrides,
  };
}

test('executeAccountMerge binds the exact reviewed plan and derives a stable server idempotency key', async () => {
  const calls = [];
  const receipt = {
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceUserId: SOURCE_USER_ID,
    targetUserId: TARGET_USER_ID,
    replayed: false,
  };
  const identity = createIdentityService(repositoryStub({
    executeAccountMerge: async input => { calls.push(input); return receipt; },
  }));

  assert.deepEqual(await identity.executeAccountMerge(ACTOR_USER_ID.toUpperCase(), executionInput()), receipt);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], idempotencyKey: undefined }, {
    actorUserId: ACTOR_USER_ID,
    sourcePlatform: 'discord',
    sourcePlatformUserId: '111',
    targetPlatform: 'telegram',
    targetPlatformUserId: '222',
    expectedSourceUserId: SOURCE_USER_ID,
    expectedTargetUserId: TARGET_USER_ID,
    expectedPlanVersion: 2,
    expectedSnapshotDigest: SNAPSHOT_DIGEST,
    resolutionMap: {},
    idempotencyKey: undefined,
  });
  assert.match(calls[0].idempotencyKey, /^account-merge:[0-9a-f]{64}$/);

  const firstKey = calls[0].idempotencyKey;
  await identity.executeAccountMerge(ACTOR_USER_ID, {
    ...executionInput(),
    idempotencyKey: 'client-controlled-value-must-be-ignored',
  });
  assert.equal(calls[1].idempotencyKey, firstKey);
});

test('merge execution validation fails closed before the repository is called', async () => {
  let calls = 0;
  const identity = createIdentityService(repositoryStub({
    executeAccountMerge: async () => { calls += 1; },
  }));
  const cases = [
    [executionInput({ expectedPlanVersion: 1 }), 'expectedPlanVersion'],
    [executionInput({ expectedSnapshotDigest: 'sha256:short' }), 'expectedSnapshotDigest'],
    [executionInput({ resolutionMap: { walletLabel: 'choose-target' } }), 'resolutionMap'],
    [executionInput({ confirmationText: `MERGE ${TARGET_USER_ID} INTO ${SOURCE_USER_ID}` }), 'confirmationText'],
    [executionInput({ expectedTargetUserId: SOURCE_USER_ID,
      confirmationText: `MERGE ${SOURCE_USER_ID} INTO ${SOURCE_USER_ID}` }), 'expectedTargetUserId'],
  ];
  for (const [input, field] of cases) {
    await assert.rejects(identity.executeAccountMerge(ACTOR_USER_ID, input), error =>
      error instanceof ValidationError && error.issues[0].field === field);
  }
  assert.equal(calls, 0);
});

test('a committed merge refreshes runtime state and the retained identity exactly once', async () => {
  const hooks = [];
  const broadcasts = [];
  const receipt = {
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceUserId: SOURCE_USER_ID,
    targetUserId: TARGET_USER_ID,
    replayed: false,
  };
  const identity = createIdentityService(repositoryStub({
    executeAccountMerge: async () => receipt,
  }), {
    onAccountMergeCommitted: async value => hooks.push(value),
    broadcast: (userId, message) => broadcasts.push({ userId, message }),
  });
  assert.deepEqual(await identity.executeAccountMerge(ACTOR_USER_ID, executionInput()), receipt);
  assert.deepEqual(hooks, [receipt]);
  assert.deepEqual(broadcasts, [{ userId: TARGET_USER_ID, message: { type: 'identity.changed' } }]);
});

test('an idempotent replay skips post-commit runtime side effects', async () => {
  const hooks = [];
  const broadcasts = [];
  const receipt = {
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceUserId: SOURCE_USER_ID,
    targetUserId: TARGET_USER_ID,
    replayed: true,
  };
  const identity = createIdentityService(repositoryStub({
    executeAccountMerge: async () => receipt,
  }), {
    onAccountMergeCommitted: value => hooks.push(value),
    broadcast: (...args) => broadcasts.push(args),
  });
  assert.deepEqual(await identity.executeAccountMerge(ACTOR_USER_ID, executionInput()), receipt);
  assert.deepEqual(hooks, []);
  assert.deepEqual(broadcasts, []);
});

test('post-commit refresh and notification failures never make a durable merge look failed', async () => {
  const receipt = {
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceUserId: SOURCE_USER_ID,
    targetUserId: TARGET_USER_ID,
    replayed: false,
  };
  const identity = createIdentityService(repositoryStub({
    executeAccountMerge: async () => receipt,
  }), {
    onAccountMergeCommitted: async () => { throw new Error('reload failed'); },
    broadcast: () => { throw new Error('socket closed'); },
  });
  assert.deepEqual(await identity.executeAccountMerge(ACTOR_USER_ID, executionInput()), receipt);
});

test('executeAccountMerge fails safely when its repository executor is unavailable', async () => {
  const repository = repositoryStub();
  delete repository.executeAccountMerge;
  const identity = createIdentityService(repository);
  await assert.rejects(identity.executeAccountMerge(ACTOR_USER_ID, executionInput()), error =>
    error instanceof ValidationError && error.issues[0].field === 'merge');
});

test('mergeExecutionInput is deterministic for the same reviewed request', () => {
  const first = identityInternals.mergeExecutionInput(ACTOR_USER_ID, executionInput());
  const second = identityInternals.mergeExecutionInput(ACTOR_USER_ID, executionInput());
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

// ── generic adminCommandService must never bypass the structured executor ──

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

test('an owner cannot run an account merge through the generic whitespace command', async () => {
  let calls = 0;
  const identity = createIdentityService(repositoryStub({
    mergeAccount: async () => { calls += 1; },
    executeAccountMerge: async () => { calls += 1; },
  }));
  const admin = createAdminCommandService(ownerGovernance(), identity);
  await assert.rejects(admin.execute('owner-user', 'merge-account discord 111 telegram 222'), error =>
    error instanceof ValidationError
      && error.issues[0].field === 'action'
      && /dedicated reviewed root-owner confirmation flow/.test(error.issues[0].message));
  assert.equal(calls, 0);
});

test('merge-account is rejected safely (not a crash) when no identity service was wired in', async () => {
  const admin = createAdminCommandService(ownerGovernance());
  await assert.rejects(admin.execute('owner-user', 'merge-account discord 111 telegram 222'),
    error => error instanceof ValidationError);
});
