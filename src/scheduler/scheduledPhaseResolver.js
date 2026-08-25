'use strict';

// Pure phase-gating logic for OpenSea-backed scheduled mints. This module deliberately never
// builds calldata and never calls OpenSea: the caller supplies the latest drop snapshot, uses the
// decision to wait or proceed, and only invokes the mint builder after a `ready` result.
const ELIGIBILITY_MODES = Object.freeze({
  SPECIFIC_STAGE: 'specific_stage',
  EARLIEST_ELIGIBLE: 'earliest_eligible',
});

const DECISION_REASONS = Object.freeze({
  READY: 'ACTIVE_STAGE_READY',
  DROP_UNAVAILABLE: 'DROP_UNAVAILABLE',
  TARGET_NOT_ACTIVE: 'TARGET_STAGE_NOT_ACTIVE',
  EARLIER_STAGE_ACTIVE: 'EARLIER_STAGE_ACTIVE',
  DEADLINE_REQUIRED: 'ELIGIBILITY_DEADLINE_REQUIRED',
  DEADLINE_PASSED: 'ELIGIBILITY_DEADLINE_PASSED',
  STAGE_IDENTITY_REQUIRED: 'STAGE_IDENTITY_REQUIRED',
  STAGE_REMOVED: 'SELECTED_STAGE_REMOVED',
  STAGE_AMBIGUOUS: 'SELECTED_STAGE_AMBIGUOUS',
  STAGE_ENDED: 'SELECTED_STAGE_ENDED',
  STAGE_INELIGIBLE: 'SELECTED_STAGE_INELIGIBLE',
  NO_LATER_STAGE: 'NO_LATER_ELIGIBLE_STAGE',
});

const DEFAULT_RECHECK_MS = 5_000;
const MAX_RECHECK_MS = 60_000;

function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedLabel(value) {
  return nonEmpty(value)?.toLowerCase().replace(/\s+/g, ' ') || null;
}

function normalizedType(value) {
  return nonEmpty(value)?.toLowerCase().replace(/[\s-]+/g, '_') || null;
}

// OpenSea's raw Drops response uses ISO snake_case timestamps; openSeaService normalizes those to
// unix seconds in camelCase. Accept both (plus epoch milliseconds used by scheduler callers) and
// expose one unambiguous epoch-millisecond representation to the phase gate.
function epochMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return epochMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!Number.isFinite(value)) return null;
  // Current unix seconds are ~1.8e9 while epoch milliseconds are ~1.8e12.
  return value < 100_000_000_000 ? Math.trunc(value * 1_000) : Math.trunc(value);
}

function normalizeOpenSeaStage(stage, index = null) {
  if (!stage || typeof stage !== 'object') return null;
  return {
    uuid: nonEmpty(stage.uuid ?? stage.stageUuid ?? stage.stage_uuid),
    label: nonEmpty(stage.label ?? stage.name ?? stage.stageLabel ?? stage.stage_label),
    stageType: nonEmpty(stage.stageType ?? stage.stage_type ?? stage.type),
    startAt: epochMs(stage.startAt ?? stage.startTime ?? stage.start_time),
    endAt: epochMs(stage.endAt ?? stage.endTime ?? stage.end_time),
    priceWei: stage.priceWei ?? stage.price ?? null,
    maxPerWallet: stage.maxPerWallet ?? stage.max_per_wallet ?? null,
    index: Number.isInteger(index) ? index : null,
  };
}

function normalizeOpenSeaDrop(drop) {
  if (!drop || typeof drop !== 'object') return null;
  const rawStages = Array.isArray(drop.stages) ? drop.stages : [];
  const activeStage = normalizeOpenSeaStage(drop.activeStage ?? drop.active_stage);
  const nextStage = normalizeOpenSeaStage(drop.nextStage ?? drop.next_stage);
  const stages = rawStages.map((stage, index) => normalizeOpenSeaStage(stage, index)).filter(Boolean);
  // Some OpenSea responses expose only active_stage/next_stage while leaving stages empty. Those
  // are still authoritative phase identities and must not make a persisted UUID look "removed".
  for (const candidate of [activeStage, nextStage]) {
    if (candidate && !stages.some(stage => sameStage(stage, candidate))) stages.push(candidate);
  }
  return {
    isMinting: typeof (drop.isMinting ?? drop.is_minting) === 'boolean'
      ? (drop.isMinting ?? drop.is_minting)
      : null,
    stages,
    activeStage,
    nextStage,
  };
}

function taskMode(task) {
  return task?.eligibilityMode ?? task?.eligibility_mode ?? ELIGIBILITY_MODES.SPECIFIC_STAGE;
}

function taskIdentity(task) {
  return {
    uuid: nonEmpty(task?.stageUuid ?? task?.stage_uuid),
    stageType: nonEmpty(task?.stageType ?? task?.stage_type),
    label: nonEmpty(task?.stageLabel ?? task?.stage_label ?? task?.phaseLabel ?? task?.phase_label),
  };
}

function sameStage(left, right) {
  if (!left || !right) return false;
  // Once either side carries an authoritative OpenSea UUID, never silently degrade that identity
  // to label/type matching. A UUID-less active snapshot is incomplete, not proof that a similarly
  // named phase is the selected one.
  if (left.uuid || right.uuid) return Boolean(left.uuid && right.uuid && left.uuid === right.uuid);
  const leftType = normalizedType(left.stageType);
  const rightType = normalizedType(right.stageType);
  const leftLabel = normalizedLabel(left.label);
  const rightLabel = normalizedLabel(right.label);
  if (leftType && rightType && leftType !== rightType) return false;
  if (leftLabel && rightLabel && leftLabel !== rightLabel) return false;
  if ((leftType && rightType) || (leftLabel && rightLabel)) {
    // A start time makes repeated same-type/same-label phases distinguishable when UUID data is
    // absent from one side of a legacy snapshot.
    return left.startAt === null || right.startAt === null || left.startAt === right.startAt;
  }
  return false;
}

function matchSelectedStage(task, stages) {
  const identity = taskIdentity(task);
  if (identity.uuid) {
    const matches = stages.filter(stage => stage.uuid === identity.uuid);
    if (matches.length === 1) return { stage: matches[0], reason: null };
    return { stage: null, reason: matches.length > 1
      ? DECISION_REASONS.STAGE_AMBIGUOUS : DECISION_REASONS.STAGE_REMOVED };
  }

  const wantedType = normalizedType(identity.stageType);
  const wantedLabel = normalizedLabel(identity.label);
  if (!wantedType && !wantedLabel) return { stage: null, reason: DECISION_REASONS.STAGE_IDENTITY_REQUIRED };
  const matches = stages.filter(stage => {
    if (wantedType && normalizedType(stage.stageType) !== wantedType) return false;
    if (wantedLabel && normalizedLabel(stage.label) !== wantedLabel) return false;
    return true;
  });
  if (matches.length === 1) return { stage: matches[0], reason: null };
  return { stage: null, reason: matches.length > 1
    ? DECISION_REASONS.STAGE_AMBIGUOUS : DECISION_REASONS.STAGE_REMOVED };
}

function stageIndex(stage, stages) {
  const found = stages.findIndex(candidate => sameStage(stage, candidate));
  return found >= 0 ? found : null;
}

function stageAtOrAfter(candidate, selected, stages) {
  if (!candidate || !selected) return false;
  if (sameStage(candidate, selected)) return true;
  if (candidate?.startAt !== null && selected?.startAt !== null) return candidate.startAt >= selected.startAt;
  const candidateIndex = stageIndex(candidate, stages);
  const selectedIndex = stageIndex(selected, stages);
  return candidateIndex !== null && selectedIndex !== null && candidateIndex >= selectedIndex;
}

function stageEnded(stage, now) {
  return stage?.endAt !== null && stage.endAt <= now;
}

function stageIsLive(stage, drop, now) {
  if (!stage || drop?.isMinting === false) return false;
  if (stage.startAt !== null && now < stage.startAt) return false;
  if (stage.endAt !== null && now >= stage.endAt) return false;
  return true;
}

function orderedStages(stages) {
  return [...stages].sort((left, right) => {
    if (left.startAt !== null && right.startAt !== null && left.startAt !== right.startAt) {
      return left.startAt - right.startAt;
    }
    if (left.startAt === null && right.startAt !== null) return 1;
    if (left.startAt !== null && right.startAt === null) return -1;
    return (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER);
  });
}

function resolveIneligibleStage(ineligibleStage, normalizedDrop) {
  if (!ineligibleStage) return normalizedDrop.activeStage;
  if (typeof ineligibleStage === 'string') {
    return normalizedDrop.stages.find(stage => stage.uuid === ineligibleStage) || null;
  }
  const normalized = normalizeOpenSeaStage(ineligibleStage);
  return normalizedDrop.stages.find(stage => sameStage(stage, normalized)) || normalized;
}

// Called after the mint provider has definitively said the wallet is ineligible for the currently
// active stage. For earliest_eligible tasks this moves forward to the next advertised stage (the
// common allowlist -> public transition) instead of asking the user to paste a Merkle proof. It
// never selects an already-ended or earlier phase and never invokes the provider's mint builder.
function selectNextStageAfterIneligibility({ task, drop, now, ineligibleStage } = {}) {
  if (taskMode(task) !== ELIGIBILITY_MODES.EARLIEST_ELIGIBLE) return null;
  const normalizedNow = epochMs(now);
  const normalizedDrop = normalizeOpenSeaDrop(drop);
  if (normalizedNow === null || !normalizedDrop) return null;
  const selected = matchSelectedStage(task, normalizedDrop.stages);
  if (!selected.stage) return null;
  const rejected = resolveIneligibleStage(ineligibleStage, normalizedDrop) || selected.stage;

  return orderedStages(normalizedDrop.stages).find(stage => (
    stageAtOrAfter(stage, selected.stage, normalizedDrop.stages)
      && !sameStage(stage, rejected)
      && stageAtOrAfter(stage, rejected, normalizedDrop.stages)
      && !stageEnded(stage, normalizedNow)
      && (stage.startAt === null || stage.startAt > normalizedNow
        || stageIsLive(stage, normalizedDrop, normalizedNow))
  )) || null;
}

function phaseRecheckMs(task) {
  const waits = Math.max(0, Number(task?.phaseWaitCount ?? task?.phase_wait_count) || 0);
  return Math.min(MAX_RECHECK_MS, DEFAULT_RECHECK_MS * (2 ** Math.min(waits, 4)));
}

function terminal(reason, context = {}) {
  return { status: 'terminal', reason, retryAt: null, nextStage: null, ...context };
}

function wait(reason, nextStage, now, deadline, recheckMs, context = {}) {
  const stageStart = nextStage?.startAt;
  const proposed = stageStart !== null && stageStart > now ? stageStart : now + recheckMs;
  return {
    status: 'wait', reason, retryAt: Math.min(proposed, deadline), deadline, nextStage, checkedAt:now,
    ...context,
  };
}

function resolveScheduledPhase({ task, drop, now, deadline, recheckMs = null,
  ineligibleStage = null } = {}) {
  const normalizedNow = epochMs(now);
  if (normalizedNow === null) throw new TypeError('now must be a valid timestamp');
  const normalizedDeadline = epochMs(deadline ?? task?.eligibilityDeadline ?? task?.eligibility_deadline);
  const effectiveRecheckMs = recheckMs ?? phaseRecheckMs(task);
  if (normalizedDeadline === null) return terminal(DECISION_REASONS.DEADLINE_REQUIRED, { deadline: null });
  if (normalizedNow >= normalizedDeadline) {
    return terminal(DECISION_REASONS.DEADLINE_PASSED, { deadline: normalizedDeadline });
  }
  const normalizedDrop = normalizeOpenSeaDrop(drop);
  if (!normalizedDrop) {
    return wait(DECISION_REASONS.DROP_UNAVAILABLE, null, normalizedNow, normalizedDeadline,
      effectiveRecheckMs, { targetStage: null, activeStage: null });
  }

  const selected = matchSelectedStage(task, normalizedDrop.stages);
  if (!selected.stage) {
    return terminal(selected.reason, { deadline: normalizedDeadline, targetStage: null,
      activeStage: normalizedDrop.activeStage });
  }

  const mode = taskMode(task);
  if (!Object.values(ELIGIBILITY_MODES).includes(mode)) {
    return terminal(DECISION_REASONS.STAGE_IDENTITY_REQUIRED, { deadline: normalizedDeadline,
      targetStage: selected.stage, activeStage: normalizedDrop.activeStage });
  }

  let targetStage = selected.stage;
  if (ineligibleStage) {
    if (mode === ELIGIBILITY_MODES.SPECIFIC_STAGE) {
      return terminal(DECISION_REASONS.STAGE_INELIGIBLE, { deadline: normalizedDeadline,
        targetStage, activeStage: normalizedDrop.activeStage });
    }
    targetStage = selectNextStageAfterIneligibility({ task, drop: normalizedDrop, now: normalizedNow,
      ineligibleStage });
    if (!targetStage) {
      return terminal(DECISION_REASONS.NO_LATER_STAGE, { deadline: normalizedDeadline,
        targetStage: selected.stage, activeStage: normalizedDrop.activeStage });
    }
  }

  const active = normalizedDrop.activeStage;
  const acceptableActive = mode === ELIGIBILITY_MODES.SPECIFIC_STAGE
    ? sameStage(active, targetStage)
    : stageAtOrAfter(active, targetStage, normalizedDrop.stages);
  if (acceptableActive && stageIsLive(active, normalizedDrop, normalizedNow)) {
    return { status: 'ready', reason: DECISION_REASONS.READY, retryAt: null,
      deadline: normalizedDeadline, targetStage, activeStage: active, nextStage: null,
      checkedAt:normalizedNow };
  }

  if (mode === ELIGIBILITY_MODES.SPECIFIC_STAGE && stageEnded(targetStage, normalizedNow)) {
    return terminal(DECISION_REASONS.STAGE_ENDED, { deadline: normalizedDeadline,
      targetStage, activeStage: active });
  }

  if (mode === ELIGIBILITY_MODES.EARLIEST_ELIGIBLE && stageEnded(targetStage, normalizedNow)) {
    const later = orderedStages(normalizedDrop.stages).find(stage => (
      stageAtOrAfter(stage, targetStage, normalizedDrop.stages)
        && !sameStage(stage, targetStage)
        && !stageEnded(stage, normalizedNow)
    ));
    if (!later) {
      return terminal(DECISION_REASONS.STAGE_ENDED, { deadline: normalizedDeadline,
        targetStage, activeStage: active });
    }
    targetStage = later;
  }

  if (targetStage.startAt !== null && targetStage.startAt >= normalizedDeadline) {
    return terminal(DECISION_REASONS.NO_LATER_STAGE, { deadline: normalizedDeadline,
      targetStage, activeStage: active });
  }

  const reason = active && !stageAtOrAfter(active, targetStage, normalizedDrop.stages)
    ? DECISION_REASONS.EARLIER_STAGE_ACTIVE : DECISION_REASONS.TARGET_NOT_ACTIVE;
  return wait(reason, targetStage, normalizedNow, normalizedDeadline, effectiveRecheckMs,
    { targetStage, activeStage: active });
}

module.exports = {
  DEFAULT_RECHECK_MS,
  DECISION_REASONS,
  ELIGIBILITY_MODES,
  MAX_RECHECK_MS,
  normalizeOpenSeaStage,
  normalizeOpenSeaDrop,
  phaseRecheckMs,
  selectNextStageAfterIneligibility,
  resolveScheduledPhase,
};
