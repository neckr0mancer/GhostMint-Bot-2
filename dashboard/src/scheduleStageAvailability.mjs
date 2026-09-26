function stageIsOpenByTime(stage, now) {
  if (!stage) return false;
  const startMs = Number(stage.startTime) * 1000;
  const endMs = Number(stage.endTime) * 1000;
  return Number.isFinite(startMs) && startMs <= now
    && (!Number.isFinite(endMs) || endMs <= 0 || endMs > now);
}

function stageIsUpcoming(stage, now) {
  if (!stage || stage.schedulable === false) return false;
  const startMs = Number(stage.startTime) * 1000;
  const endMs = Number(stage.endTime) * 1000;
  return Number.isFinite(startMs) && startMs > now
    && (!Number.isFinite(endMs) || endMs <= 0 || (endMs > now && endMs > startMs));
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function scheduleStageDisplayName(stage) {
  const label = text(stage?.label);
  if (label) return label;
  const rawType = text(stage?.stageType ?? stage?.stage_type);
  if (!rawType) return 'Mint stage';
  return rawType
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

// Eligibility words are spend-critical UI. Only an explicit wallet-specific result may say
// "Eligible" or "Not eligible". Public phases are open to all wallets; future gated phases that
// OpenSea cannot prove yet remain selectable but are labelled "Checked at opening".
export function scheduleStageChoiceState(stage, now = Date.now(), { authoritativeLive = null } = {}) {
  const startMs = Number(stage?.startTime) * 1000;
  const endMs = Number(stage?.endTime) * 1000;
  const ended = Number.isFinite(endMs) && endMs > 0 && endMs <= now;
  const live = Number.isFinite(startMs) && startMs <= now
    && (!Number.isFinite(endMs) || endMs <= 0 || endMs > now);
  const eligibility = text(stage?.eligibilityState).toLowerCase();

  if (stage?.identityAmbiguous || stage?.schedulable === false) {
    return { tag:'Unavailable', disabled:true, state:'unavailable' };
  }
  // The provider's active-stage signal is stronger than the published timestamps. Projects can
  // leave a stale end time behind while the phase is still open, just as they can postpone a
  // phase after its advertised start. Keep both cases truthful instead of letting timestamps
  // override an explicit live/not-live response.
  if (authoritativeLive === true) return { tag:'Live - use Mint now', disabled:true, state:'live' };
  if (ended) return { tag:'Ended', disabled:true, state:'ended' };
  if (live && authoritativeLive === false) {
    return { tag:'Not live yet', disabled:true, state:'not_live' };
  }
  if (live) return { tag:'Live - use Mint now', disabled:true, state:'live' };
  if (eligibility === 'ineligible') return { tag:'Not eligible', disabled:true, state:'ineligible' };
  if (eligibility === 'eligible') return { tag:'Eligible', disabled:false, state:'eligible' };
  if (eligibility === 'open_to_all') return { tag:'Open to all', disabled:false, state:'open_to_all' };
  return { tag:'Checked at opening', disabled:false, state:'check_at_open' };
}

// OpenSea's explicit isMinting/activeStage pair is authoritative when present. A timestamp can
// pass while a project postpones the actual opening, so time alone must never produce a false
// "Live now" state. Timestamp fallback is reserved for providers/contracts with no live-state
// signal at all.
export function scheduleStageAvailability({ drop, startTime, endTime, priceWeiPerItem, now = Date.now() } = {}) {
  const stages = Array.isArray(drop?.stages)
    ? [...drop.stages].sort((left, right) => Number(left.startTime) - Number(right.startTime))
    : [];
  // Mirror the server planner: a stale record whose end has already passed is not a usable future
  // choice even if its start field is malformed and appears to be ahead of us.
  const futureStages = stages.filter(stage => stageIsUpcoming(stage, now));
  const hasAuthoritativeMintingState = typeof drop?.isMinting === 'boolean';

  let liveStage = null;
  if (hasAuthoritativeMintingState) {
    liveStage = drop.isMinting && drop.activeStage ? drop.activeStage : null;
  } else if (drop?.activeStage && stageIsOpenByTime(drop.activeStage, now)) {
    liveStage = drop.activeStage;
  } else if (stages.length) {
    liveStage = stages.find(stage => stage.schedulable !== false && stageIsOpenByTime(stage, now)) || null;
  } else if (!drop && stageIsOpenByTime({ startTime, endTime }, now)) {
    liveStage = { label:'Public mint', stageType:'public', startTime, endTime, priceWei:priceWeiPerItem };
  }

  return { stages, futureStages, liveStage, hasAuthoritativeMintingState };
}
