'use strict';

const DIRECT_PUBLIC_DROP_STAGE_TYPE = 'seadrop_public_drop';
const PUBLIC_STAGE_TYPES = new Set(['public', 'public_sale', 'publicsale', 'public_drop', DIRECT_PUBLIC_DROP_STAGE_TYPE]);
const EXPLICIT_WALLET_ELIGIBILITY_STATES = new Set(['eligible', 'ineligible']);
const ELIGIBILITY_WINDOW_SECONDS = 24 * 60 * 60;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeStageType(value) {
  return text(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function stageRequiresEligibilityCheck(stage) {
  if (!stage) return false;
  const type = normalizeStageType(stage.stageType ?? stage.stage_type);
  if (PUBLIC_STAGE_TYPES.has(type)) return false;
  if (!type && /^public(?:\s+sale)?$/i.test(text(stage.label))) return false;
  return true;
}

function isDirectPublicDropStage(stage) {
  const uuid = text(stage?.uuid ?? stage?.stageUuid);
  const type = normalizeStageType(stage?.stageType ?? stage?.stage_type);
  return !uuid && type === DIRECT_PUBLIC_DROP_STAGE_TYPE;
}

function scheduleStageKey(stage) {
  const uuid = text(stage?.uuid);
  if (uuid) return `uuid:${uuid}`;
  return `stage:${text(stage?.stageType ?? stage?.stage_type).toLowerCase()}:${text(stage?.label).toLowerCase()}:${Number(stage?.startTime) || ''}:${Number(stage?.endTime) || ''}`;
}

function scheduleStagePersistenceKey(stage) {
  const uuid = text(stage?.uuid).toLowerCase();
  if (uuid) return `uuid:${uuid}`;
  const type = normalizeStageType(stage?.stageType ?? stage?.stage_type);
  const label = text(stage?.label).toLowerCase();
  return type || label ? `phase:${type}:${label}` : null;
}

function scheduleReservationStageKey({ stageUuid, stageLabel, stageType, mintTime,
  directPublic = false } = {}) {
  // A provider UUID is the identity of one exact advertised phase. Keep it even when execution uses
  // SeaDrop's direct mintPublic call: a collection may advertise two distinct public phases and the
  // user must be able to reserve each one independently. Only the UUID-less on-chain fallback uses
  // the canonical PublicDrop identity.
  if (directPublic && isDirectPublicDropStage({ stageUuid,stageLabel,stageType })) {
    return 'phase:direct_public';
  }
  const phase = scheduleStagePersistenceKey({ uuid:stageUuid,label:stageLabel,stageType });
  if (phase) return phase;
  const timestamp = Number(mintTime);
  if (!Number.isFinite(timestamp)) return null;
  return `manual:${new Date(timestamp).toISOString()}`;
}

function reservationTimeSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  let timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp)) timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp < 1_000_000_000_000) timestamp *= 1_000;
  return Math.floor(timestamp / 1_000);
}

function scheduleReservationStagesConflict(left = {}, right = {}) {
  const leftKey = scheduleReservationStageKey(left);
  const rightKey = scheduleReservationStageKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  // Metadata can appear after a UUID-less on-chain schedule was saved. Treat a newly indexed public
  // phase as the same reservation only when its authoritative opening matches the synthesized
  // fallback. Do not globally collapse provider phases: distinct public stages remain schedulable.
  const aliasesFallback = (leftKey === 'phase:direct_public') !== (rightKey === 'phase:direct_public');
  if (!aliasesFallback) return false;
  const indexedStage = leftKey === 'phase:direct_public' ? right : left;
  if (stageRequiresEligibilityCheck({ label:indexedStage.stageLabel,
    stageType:indexedStage.stageType })) return false;
  const leftStart = reservationTimeSeconds(left.stageStartAt ?? left.mintTime);
  const rightStart = reservationTimeSeconds(right.stageStartAt ?? right.mintTime);
  return leftStart !== null && rightStart !== null && leftStart === rightStart;
}

function scheduleStageCoreFacts(stage, { stages = [] } = {}) {
  const requiresEligibilityCheck = stageRequiresEligibilityCheck(stage);
  // A provider-specific proof lookup may already have produced a wallet-specific answer. Preserve
  // only those definitive answers here. Generic OpenSea stage metadata cannot prove a future
  // allowlist either way, so missing/unknown values still become `check_at_open`; public stages
  // remain `open_to_all` without pretending that a wallet proof was performed.
  const explicitEligibilityState = text(stage?.eligibilityState ?? stage?.eligibility_state).toLowerCase();
  const eligibilityState = EXPLICIT_WALLET_ELIGIBILITY_STATES.has(explicitEligibilityState)
    ? explicitEligibilityState
    : requiresEligibilityCheck ? 'check_at_open' : 'open_to_all';
  const eligibilityLabel = eligibilityState === 'eligible'
    ? 'Eligible for this wallet'
    : eligibilityState === 'ineligible'
      ? 'Not eligible for this wallet'
      : eligibilityState === 'check_at_open'
        ? 'Eligibility checked at opening'
        : 'Open to all wallets';
  const persistenceKey = scheduleStagePersistenceKey(stage);
  const sameIdentityCount = persistenceKey
    ? stages.filter(candidate => scheduleStagePersistenceKey(candidate) === persistenceKey).length
    : 0;
  const identityAmbiguous = !stage?.uuid && sameIdentityCount > 1;
  return {
    requiresEligibilityCheck,
    eligibilityMode: requiresEligibilityCheck ? 'earliest_eligible' : 'specific_stage',
    eligibilityState,
    eligibilityLabel,
    identityAmbiguous,
    schedulable: Boolean(persistenceKey) && !identityAmbiguous,
  };
}

function scheduleStageFacts(stage, { stages = [] } = {}) {
  const core = scheduleStageCoreFacts(stage, { stages });
  const startTime = Number(stage?.startTime);
  const advancesIfIneligible = core.requiresEligibilityCheck && Number.isFinite(startTime)
    && stages.some(candidate => {
      const candidateStart = Number(candidate?.startTime);
      const candidateEnd = Number(candidate?.endTime);
      const validWindow = !Number.isFinite(candidateEnd) || candidateEnd <= 0
        || candidateEnd > candidateStart;
      const candidateFacts = scheduleStageCoreFacts(candidate, { stages });
      return scheduleStageKey(candidate) !== scheduleStageKey(stage)
        && Number.isFinite(candidateStart) && candidateStart > startTime
        && candidateStart <= startTime + ELIGIBILITY_WINDOW_SECONDS
        && validWindow && candidateFacts.schedulable
        && (candidateFacts.eligibilityState === 'eligible'
          || candidateFacts.eligibilityState === 'open_to_all');
    });
  return { ...core, advancesIfIneligible };
}

function uniqueStages(drop) {
  const candidates = [
    ...(Array.isArray(drop?.stages) ? drop.stages : []),
    drop?.activeStage,
    drop?.nextStage,
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter(stage => {
    const key = scheduleStageKey(stage);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decorateScheduleDrop(drop) {
  if (!drop) return null;
  const stages = uniqueStages(drop);
  const decorate = stage => stage ? { ...stage, ...scheduleStageFacts(stage, { stages }) } : null;
  return {
    ...drop,
    // Some provider responses expose a future phase only through `nextStage`. Return one complete,
    // de-duplicated list so every client sees the same schedulable choices.
    stages:stages.map(decorate),
    activeStage:decorate(drop.activeStage),
    nextStage:decorate(drop.nextStage),
  };
}

// A future allowlist cannot be called "eligible" until its provider can issue the wallet-specific
// proof/signature. Keep unknown gated stages available to clients for an explicit manual choice,
// but never auto-recommend one. The safe recommendation is the earliest upcoming stage which is
// either explicitly eligible for this wallet or open to every wallet.
function buildScheduleStagePlan(drop, { now = Date.now() } = {}) {
  const stages = uniqueStages(drop);
  const upcoming = stages
    .filter(stage => {
      const startMs = Number(stage?.startTime) * 1000;
      const endMs = Number(stage?.endTime) * 1000;
      const facts = scheduleStageFacts(stage, { stages });
      return Number.isFinite(startMs) && startMs > now
        && (!Number.isFinite(endMs) || endMs <= 0 || (endMs > now && endMs > startMs))
        && facts.schedulable
        && (facts.eligibilityState === 'eligible' || facts.eligibilityState === 'open_to_all');
    })
    .sort((left, right) => Number(left.startTime) - Number(right.startTime));
  const stage = upcoming[0] || null;
  if (!stage) return null;
  const facts = scheduleStageFacts(stage, { stages });
  return {
    recommendedStageKey: scheduleStageKey(stage),
    recommendedStageUuid: text(stage.uuid) || null,
    recommendedStageLabel: text(stage.label) || null,
    recommendedStageType: text(stage.stageType ?? stage.stage_type) || null,
    eligibilityMode: facts.eligibilityMode,
    eligibilityState: facts.eligibilityState,
    eligibilityLabel: facts.eligibilityLabel,
    advancesIfIneligible: facts.advancesIfIneligible,
  };
}

// Resolve a persisted/server-owned recommendation back to one exact stage from the latest drop
// snapshot. UUID is the strongest identity OpenSea gives us, so when the plan carries one we never
// fall back to a looser display-derived key. A key-only plan is supported for providers that do not
// expose UUIDs, but only when it matches exactly one still-upcoming, non-ambiguous stage.
//
// This deliberately does not choose the first stage when the plan is absent or stale. Callers may
// still offer every safe stage for manual selection, but an "automatic" action must only exist when
// the shared planner supplied a recommendation that can be resolved without guessing.
function resolveRecommendedScheduleStage({ drop, schedulePlan, now = Date.now() } = {}) {
  if (!drop || !schedulePlan) return null;
  const allStages = uniqueStages(drop);
  const candidates = allStages.filter(stage => {
    const startMs = Number(stage?.startTime) * 1000;
    const endMs = Number(stage?.endTime) * 1000;
    const facts = scheduleStageFacts(stage, { stages: allStages });
    return Number.isFinite(startMs) && startMs > now
      && (!Number.isFinite(endMs) || endMs <= 0 || endMs > now)
      && facts.schedulable
      && (facts.eligibilityState === 'eligible' || facts.eligibilityState === 'open_to_all');
  });

  const uuid = text(schedulePlan.recommendedStageUuid);
  if (uuid) {
    const matches = candidates.filter(stage => text(stage?.uuid) === uuid);
    return matches.length === 1 ? matches[0] : null;
  }

  const key = text(schedulePlan.recommendedStageKey);
  if (!key) return null;
  const matches = candidates.filter(stage => scheduleStageKey(stage) === key);
  return matches.length === 1 ? matches[0] : null;
}

module.exports = {
  buildScheduleStagePlan,
  decorateScheduleDrop,
  normalizeStageType,
  scheduleStageFacts,
  scheduleStageKey,
  scheduleStagePersistenceKey,
  scheduleReservationStageKey,
  scheduleReservationStagesConflict,
  isDirectPublicDropStage,
  stageRequiresEligibilityCheck,
  resolveRecommendedScheduleStage,
};
