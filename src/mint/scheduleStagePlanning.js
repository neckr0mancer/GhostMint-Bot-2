'use strict';

const PUBLIC_STAGE_TYPES = new Set(['public', 'public_sale', 'publicsale', 'public_drop']);
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

function scheduleReservationStageKey({ stageUuid, stageLabel, stageType, mintTime } = {}) {
  const phase = scheduleStagePersistenceKey({ uuid:stageUuid,label:stageLabel,stageType });
  if (phase) return phase;
  const timestamp = Number(mintTime);
  if (!Number.isFinite(timestamp)) return null;
  return `manual:${new Date(timestamp).toISOString()}`;
}

function scheduleStageFacts(stage, { stages = [] } = {}) {
  const requiresEligibilityCheck = stageRequiresEligibilityCheck(stage);
  const persistenceKey = scheduleStagePersistenceKey(stage);
  const sameIdentityCount = persistenceKey
    ? stages.filter(candidate => scheduleStagePersistenceKey(candidate) === persistenceKey).length
    : 0;
  const identityAmbiguous = !stage?.uuid && sameIdentityCount > 1;
  const startTime = Number(stage?.startTime);
  const advancesIfIneligible = requiresEligibilityCheck && Number.isFinite(startTime)
    && stages.some(candidate => {
      const candidateStart = Number(candidate?.startTime);
      return scheduleStageKey(candidate) !== scheduleStageKey(stage)
        && Number.isFinite(candidateStart) && candidateStart > startTime
        && candidateStart <= startTime + ELIGIBILITY_WINDOW_SECONDS;
    });
  return {
    requiresEligibilityCheck,
    eligibilityMode: requiresEligibilityCheck ? 'earliest_eligible' : 'specific_stage',
    eligibilityState: requiresEligibilityCheck ? 'check_at_open' : 'open_to_all',
    eligibilityLabel: requiresEligibilityCheck ? 'Eligibility checked at opening' : 'Open to all wallets',
    advancesIfIneligible,
    identityAmbiguous,
    schedulable: Boolean(persistenceKey) && !identityAmbiguous,
  };
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
// proof/signature. Recommend the earliest upcoming stage and make that uncertainty explicit. The
// existing earliest_eligible worker mode will test it at opening and advance if the wallet is
// rejected; public stages need no such provider decision.
function buildScheduleStagePlan(drop, { now = Date.now() } = {}) {
  const stages = uniqueStages(drop);
  const upcoming = stages
    .filter(stage => {
      const startMs = Number(stage?.startTime) * 1000;
      const endMs = Number(stage?.endTime) * 1000;
      return Number.isFinite(startMs) && startMs > now
        && (!Number.isFinite(endMs) || endMs <= 0 || endMs > now)
        && scheduleStageFacts(stage, { stages }).schedulable;
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

module.exports = {
  buildScheduleStagePlan,
  decorateScheduleDrop,
  normalizeStageType,
  scheduleStageFacts,
  scheduleStageKey,
  scheduleStagePersistenceKey,
  scheduleReservationStageKey,
  stageRequiresEligibilityCheck,
};
