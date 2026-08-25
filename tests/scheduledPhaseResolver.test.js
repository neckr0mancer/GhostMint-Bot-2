const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RECHECK_MS,
  DECISION_REASONS,
  MAX_RECHECK_MS,
  normalizeOpenSeaStage,
  resolveScheduledPhase,
  selectNextStageAfterIneligibility,
} = require('../src/scheduler/scheduledPhaseResolver');

const minute = 60_000;
const now = Date.parse('2026-08-24T12:00:00.000Z');
const deadline = now + 30 * minute;

function rawStage(uuid, label, type, startOffset, endOffset) {
  return {
    uuid, label, stage_type: type,
    start_time: new Date(now + startOffset).toISOString(),
    end_time: new Date(now + endOffset).toISOString(),
  };
}

function normalizedStage(uuid, label, type, startOffset, endOffset) {
  return {
    uuid, label, stageType: type,
    startTime: Math.floor((now + startOffset) / 1_000),
    endTime: Math.floor((now + endOffset) / 1_000),
  };
}

test('normalizes both raw OpenSea fields and openSeaService unix-second fields to epoch milliseconds', () => {
  const raw = normalizeOpenSeaStage(rawStage('public', 'Public', 'public_sale', -minute, minute));
  const normalized = normalizeOpenSeaStage(normalizedStage('public', 'Public', 'public_sale', -minute, minute));
  assert.equal(raw.startAt, now - minute);
  assert.equal(normalized.startAt, now - minute);
  assert.equal(raw.stageType, 'public_sale');
  assert.equal(normalized.endAt, now + minute);
});

test('a delayed public phase waits and polls until OpenSea marks that exact stage active', () => {
  const publicStage = rawStage('public', 'Public', 'public_sale', -minute, 20 * minute);
  const task = { eligibilityMode: 'specific_stage', stageUuid: 'public', eligibilityDeadline: deadline };
  const waiting = resolveScheduledPhase({ task, drop: { is_minting: false, stages: [publicStage] }, now });
  assert.equal(waiting.status, 'wait');
  assert.equal(waiting.reason, DECISION_REASONS.TARGET_NOT_ACTIVE);
  assert.equal(waiting.retryAt, now + DEFAULT_RECHECK_MS, 'advertised time is not treated as proof the phase is live');
  assert.equal(waiting.deadline, deadline);
  assert.equal(waiting.nextStage.uuid, 'public');

  const ready = resolveScheduledPhase({ task,
    drop: { is_minting: true, stages: [publicStage], active_stage: publicStage }, now });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.activeStage.uuid, 'public');
});

test('active/next-only OpenSea snapshots still preserve persisted stage UUID matching', () => {
  const publicStage = rawStage('public', 'Public', 'public_sale', minute, 20 * minute);
  const decision = resolveScheduledPhase({
    task:{ eligibilityMode:'specific_stage', stageUuid:'public', eligibilityDeadline:deadline },
    drop:{ is_minting:false, stages:[], next_stage:publicStage }, now,
  });
  assert.equal(decision.status, 'wait');
  assert.equal(decision.nextStage.uuid, 'public');
  assert.equal(decision.retryAt, now + minute);
});

test('a public-specific task never fires during an earlier active allowlist stage', () => {
  const allowlist = rawStage('allow', 'Allowlist', 'allowlist', -minute, 5 * minute);
  const publicStage = rawStage('public', 'Public', 'public_sale', 5 * minute, 20 * minute);
  const decision = resolveScheduledPhase({
    task: { eligibilityMode: 'specific_stage', stageUuid: 'public', eligibilityDeadline: deadline },
    drop: { is_minting: true, stages: [allowlist, publicStage], active_stage: allowlist }, now,
  });
  assert.equal(decision.status, 'wait');
  assert.equal(decision.reason, DECISION_REASONS.EARLIER_STAGE_ACTIVE);
  assert.equal(decision.retryAt, now + 5 * minute);
  assert.equal(decision.nextStage.uuid, 'public');
});

test('earliest eligible accepts a live later phase and the ineligibility helper advances to public', () => {
  const allowlist = normalizedStage('allow', 'Allowlist', 'allowlist', -minute, 5 * minute);
  const publicStage = normalizedStage('public', 'Public', 'public_sale', 5 * minute, 20 * minute);
  const task = { eligibilityMode: 'earliest_eligible', stageUuid: 'allow', eligibilityDeadline: deadline };

  const next = selectNextStageAfterIneligibility({ task,
    drop: { stages: [allowlist, publicStage], activeStage: allowlist }, now, ineligibleStage: 'allow' });
  assert.equal(next.uuid, 'public', 'an ineligible allowlist stage advances to the next advertised public stage');

  const laterNow = now + 6 * minute;
  const ready = resolveScheduledPhase({ task,
    drop: { isMinting: true, stages: [allowlist, publicStage], activeStage: publicStage },
    now: laterNow, deadline,
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.activeStage.uuid, 'public');
});

test('an ineligibility rejection can advance to a later phase that became live during the builder call', () => {
  const allowlist = normalizedStage('allow', 'Allowlist', 'allowlist', -10 * minute, -minute);
  const publicStage = normalizedStage('public', 'Public', 'public_sale', -minute, 20 * minute);
  const task = { eligibilityMode:'earliest_eligible', stageUuid:'allow', eligibilityDeadline:deadline };
  const drop = { isMinting:true, stages:[allowlist, publicStage], activeStage:publicStage };
  assert.equal(selectNextStageAfterIneligibility({ task, drop, now, ineligibleStage:allowlist }).uuid, 'public');
  const decision = resolveScheduledPhase({ task, drop, now, ineligibleStage:allowlist });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.activeStage.uuid, 'public');
});

test('a persisted UUID never matches a UUID-less active stage by label alone', () => {
  const selected = rawStage('public', 'Public', 'public_sale', -minute, 20 * minute);
  const activeWithoutUuid = { ...selected, uuid:null };
  const decision = resolveScheduledPhase({
    task:{ eligibilityMode:'specific_stage', stageUuid:'public', eligibilityDeadline:deadline },
    drop:{ is_minting:true, stages:[selected], active_stage:activeWithoutUuid }, now,
  });
  assert.equal(decision.status, 'wait');
  assert.equal(decision.reason, DECISION_REASONS.TARGET_NOT_ACTIVE);
});

test('past-due phase polling backs off from five seconds to a one-minute cap', () => {
  const stage = rawStage('public', 'Public', 'public_sale', -minute, 20 * minute);
  const base = { eligibilityMode:'specific_stage', stageUuid:'public', eligibilityDeadline:deadline };
  const first = resolveScheduledPhase({ task:{ ...base, phaseWaitCount:0 },
    drop:{ is_minting:false, stages:[stage] }, now });
  const backedOff = resolveScheduledPhase({ task:{ ...base, phaseWaitCount:20 },
    drop:{ is_minting:false, stages:[stage] }, now });
  assert.equal(first.retryAt, now + DEFAULT_RECHECK_MS);
  assert.equal(backedOff.retryAt, now + MAX_RECHECK_MS);
});

test('legacy stageType/label matching fails closed when it is ambiguous', () => {
  const first = rawStage('one', 'Public', 'public_sale', minute, 5 * minute);
  const second = rawStage('two', 'Public', 'public_sale', 10 * minute, 15 * minute);
  const decision = resolveScheduledPhase({
    task: { eligibilityMode: 'specific_stage', stageType: 'public_sale', stageLabel: 'Public',
      eligibilityDeadline: deadline },
    drop: { stages: [first, second] }, now,
  });
  assert.equal(decision.status, 'terminal');
  assert.equal(decision.reason, DECISION_REASONS.STAGE_AMBIGUOUS);
});

test('a missing UUID is terminal rather than silently matching a different phase', () => {
  const decision = resolveScheduledPhase({
    task: { eligibilityMode: 'specific_stage', stageUuid: 'removed', eligibilityDeadline: deadline },
    drop: { stages: [rawStage('public', 'Public', 'public_sale', minute, 5 * minute)] }, now,
  });
  assert.equal(decision.status, 'terminal');
  assert.equal(decision.reason, DECISION_REASONS.STAGE_REMOVED);
});

test('the eligibility deadline is mandatory and a passed deadline is terminal', () => {
  const stage = rawStage('public', 'Public', 'public_sale', -minute, 5 * minute);
  const noDeadline = resolveScheduledPhase({
    task: { eligibilityMode: 'specific_stage', stageUuid: 'public' },
    drop: { isMinting: true, stages: [stage], activeStage: stage }, now,
  });
  assert.equal(noDeadline.status, 'terminal');
  assert.equal(noDeadline.reason, DECISION_REASONS.DEADLINE_REQUIRED);

  const expired = resolveScheduledPhase({
    task: { eligibilityMode: 'specific_stage', stageUuid: 'public', eligibilityDeadline: now },
    drop: { isMinting: true, stages: [stage], activeStage: stage }, now,
  });
  assert.equal(expired.status, 'terminal');
  assert.equal(expired.reason, DECISION_REASONS.DEADLINE_PASSED);
});
