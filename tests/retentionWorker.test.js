const assert = require('node:assert/strict');
const test = require('node:test');
const { createRetentionWorker, evaluateRetention } = require('../src/governance/retentionWorker');

const NOW = Date.parse('2026-06-01T00:00:00Z');
const nowFn = () => NOW;

test('a good-standing override unconditionally renews, regardless of any configured criteria', () => {
  const decision = evaluateRetention({
    goodStandingOverride: true, requireActiveSubscription: true, subscriptionActive: false,
    requireRecentActivityDays: 7, lastActivityAt: null,
  }, { now: nowFn });
  assert.equal(decision.renew, true);
  assert.match(decision.reason, /good standing/i);
});

test('a group with no configured retention criteria always renews', () => {
  const decision = evaluateRetention({
    goodStandingOverride: false, requireActiveSubscription: false, requireRecentActivityDays: null,
  }, { now: nowFn });
  assert.equal(decision.renew, true);
});

test('an inactive subscription fails a subscription-required policy', () => {
  const decision = evaluateRetention({
    goodStandingOverride: false, requireActiveSubscription: true, subscriptionActive: false,
    requireRecentActivityDays: null,
  }, { now: nowFn });
  assert.equal(decision.renew, false);
  assert.match(decision.reason, /subscription/i);
});

test('an active subscription satisfies a subscription-required policy', () => {
  const decision = evaluateRetention({
    goodStandingOverride: false, requireActiveSubscription: true, subscriptionActive: true,
    requireRecentActivityDays: null,
  }, { now: nowFn });
  assert.equal(decision.renew, true);
});

test('activity older than the required window fails an activity-required policy; recent activity passes it', () => {
  const requireRecentActivityDays = 7;
  const tooOld = new Date(NOW - 10 * 86_400_000).toISOString();
  const recent = new Date(NOW - 2 * 86_400_000).toISOString();

  const stale = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: false,
    requireRecentActivityDays, lastActivityAt: tooOld }, { now: nowFn });
  assert.equal(stale.renew, false);
  assert.match(stale.reason, /activity/i);

  const fresh = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: false,
    requireRecentActivityDays, lastActivityAt: recent }, { now: nowFn });
  assert.equal(fresh.renew, true);
});

test('no activity at all fails an activity-required policy the same as stale activity', () => {
  const decision = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: false,
    requireRecentActivityDays: 7, lastActivityAt: null }, { now: nowFn });
  assert.equal(decision.renew, false);
});

test('a policy requiring both subscription and activity needs both satisfied to renew', () => {
  const recent = new Date(NOW - 1 * 86_400_000).toISOString();
  const bothFail = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: true,
    subscriptionActive: false, requireRecentActivityDays: 7, lastActivityAt: null }, { now: nowFn });
  assert.equal(bothFail.renew, false);

  const onlyActivityPasses = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: true,
    subscriptionActive: false, requireRecentActivityDays: 7, lastActivityAt: recent }, { now: nowFn });
  assert.equal(onlyActivityPasses.renew, false, 'subscription still required even though activity passed');

  const bothPass = evaluateRetention({ goodStandingOverride: false, requireActiveSubscription: true,
    subscriptionActive: true, requireRecentActivityDays: 7, lastActivityAt: recent }, { now: nowFn });
  assert.equal(bothPass.renew, true);
});

test('the worker renews a due item that meets criteria and removes one that does not, isolating failures per item', () => {
  return (async () => {
    const renewed = [];
    const removed = [];
    const dueItems = [
      { userId: 'renews', groupId: 'group-a', groupName: 'VIP', scheduledRemovalAt: new Date(NOW),
        retentionPeriodDays: 30, requireActiveSubscription: false, requireRecentActivityDays: null,
        goodStandingOverride: false, subscriptionActive: false, lastActivityAt: null },
      { userId: 'removed', groupId: 'group-a', groupName: 'VIP', scheduledRemovalAt: new Date(NOW),
        retentionPeriodDays: 30, requireActiveSubscription: true, requireRecentActivityDays: null,
        goodStandingOverride: false, subscriptionActive: false, lastActivityAt: null },
      { userId: 'errors-safely', groupId: 'group-a', groupName: 'VIP', scheduledRemovalAt: new Date(NOW),
        retentionPeriodDays: 30, requireActiveSubscription: false, requireRecentActivityDays: null,
        goodStandingOverride: false, subscriptionActive: false, lastActivityAt: null },
    ];
    const repository = {
      listDueRetentions: async () => dueItems,
      renewRetention: async input => {
        if (input.userId === 'errors-safely') throw new Error('simulated DB hiccup');
        renewed.push(input);
      },
      removeFromGroupForRetention: async input => removed.push(input),
    };
    const errors = [];
    const worker = createRetentionWorker({ repository, now: nowFn, log: message => errors.push(message) });
    await worker.tick();

    assert.equal(renewed.length, 1);
    assert.equal(renewed[0].userId, 'renews');
    assert.ok(renewed[0].nextScheduledRemovalAt instanceof Date);
    assert.equal(renewed[0].nextScheduledRemovalAt.getTime(), NOW + 30 * 86_400_000);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].userId, 'removed');
    assert.match(removed[0].reason, /subscription/i);

    assert.ok(errors.some(message => message.includes('errors-safely')), 'a per-item failure is logged, not thrown');
    assert.equal(worker.health().lastError, null, 'an isolated per-item failure does not count as a tick-level error');
  })();
});

test('a whole-tick failure (e.g. listDueRetentions itself throwing) marks the worker health as down without crashing', async () => {
  const repository = { listDueRetentions: async () => { throw new Error('database unavailable'); } };
  const worker = createRetentionWorker({ repository, now: nowFn, log: () => {} });
  await worker.tick();
  assert.equal(worker.health().status, 'down');
});

test('overlapping ticks do not run concurrently', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const repository = {
    listDueRetentions: async () => {
      concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      concurrent -= 1;
      return [];
    },
  };
  const worker = createRetentionWorker({ repository, now: nowFn, log: () => {} });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(maxConcurrent, 1);
});
