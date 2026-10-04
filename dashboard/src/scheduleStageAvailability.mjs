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

// An incomplete provider catalog can prove that the public window we saw has ended, but it
// cannot prove that the collection has no other stage. Keep that scoped state separate from a
// terminal whole-drop result so the UI never overstates what the provider actually returned.
export function scheduleDropEndState({ soldOut = false, ended = false, stageCatalogComplete = null } = {}) {
  const verifiedWindowEnded = Boolean(!soldOut && ended && stageCatalogComplete === false);
  return {
    terminal: Boolean(soldOut || (ended && !verifiedWindowEnded)),
    verifiedWindowEnded,
  };
}

// Eligibility words are spend-critical UI. Only an explicit wallet-specific result may say
// "Eligible" or "Not eligible". Public phases are open to all wallets; future gated phases that
// OpenSea cannot prove yet remain selectable but are labelled "Checked at opening".
export function scheduleStageChoiceState(stage, now = Date.now(), {
  authoritativeLive = null,
  authoritativeSoldOut = false,
} = {}) {
  const startMs = Number(stage?.startTime) * 1000;
  const endMs = Number(stage?.endTime) * 1000;
  const ended = Number.isFinite(endMs) && endMs > 0 && endMs <= now;
  const live = Number.isFinite(startMs) && startMs <= now
    && (!Number.isFinite(endMs) || endMs <= 0 || endMs > now);
  const rawEligibility = text(stage?.eligibilityState).toLowerCase();
  const eligibilityState = ['eligible','ineligible','open_to_all'].includes(rawEligibility)
    ? rawEligibility
    : 'check_at_open';

  // Liveness and wallet eligibility answer different questions. A stage can be live while this
  // wallet is explicitly ineligible, so "Live - use Mint now" must never replace the wallet's
  // eligibility badge. Live is rendered beside the stage name; the right-side badge keeps the
  // wallet result. The stage still stays disabled for scheduling because it has already opened.
  const eligibilityPresentation = eligibilityState === 'ineligible'
    ? { tag:'Not eligible', tone:'ineligible' }
    : eligibilityState === 'eligible'
      ? { tag:'Eligible', tone:'eligible' }
      : eligibilityState === 'open_to_all'
        ? { tag:'Eligible', tone:'open_to_all' }
        : { tag:'Checked at opening', tone:'check_at_open' };

  const providerLive = authoritativeLive === true;
  const providerInactive = authoritativeLive === false;
  const stageStatus = authoritativeSoldOut
    ? 'Sold Out'
    : providerLive || (live && !providerInactive)
      ? 'Live'
      : ended
        ? 'Ended'
        : live && providerInactive
          ? 'Not Active'
          : 'Not Started';
  const stageStatusTone = stageStatus === 'Live'
    ? 'success'
    : stageStatus === 'Ended' || stageStatus === 'Sold Out'
      ? 'ended'
      : 'pending';
  const shared = { ...eligibilityPresentation, eligibilityState, stageStatus, stageStatusTone };

  if (stage?.identityAmbiguous || stage?.schedulable === false) {
    return { ...shared, tag:'Eligibility unavailable', tone:'unavailable', disabled:true, state:'unavailable' };
  }
  if (authoritativeSoldOut) return { ...shared, disabled:true, state:'sold_out', soldOut:true };
  // The provider's active-stage signal is stronger than the published timestamps. Projects can
  // leave a stale end time behind while the phase is still open, just as they can postpone a
  // phase after its advertised start. Keep both cases truthful instead of letting timestamps
  // override an explicit live/not-live response.
  if (providerLive) return { ...shared, disabled:true, state:'live', live:true };
  if (ended) return { ...shared, disabled:true, state:'ended' };
  if (live && authoritativeLive === false) {
    return { ...shared, disabled:true, state:'not_live' };
  }
  if (live) return { ...shared, disabled:true, state:'live', live:true };
  if (eligibilityState === 'ineligible') return { ...shared, disabled:true, state:'ineligible' };
  return { ...shared, disabled:false, state:eligibilityState };
}

// OpenSea's explicit isMinting/activeStage pair is authoritative when present. A timestamp can
// pass while a project postpones the actual opening, so time alone must never produce a false
// "Live now" state. Timestamp fallback is reserved for providers/contracts with no live-state
// signal at all.
export function scheduleStageAvailability({
  drop,
  startTime,
  endTime,
  priceWeiPerItem,
  soldOut: soldOutValue = false,
  now = Date.now(),
} = {}) {
  const stages = Array.isArray(drop?.stages)
    ? [...drop.stages].sort((left, right) => Number(left.startTime) - Number(right.startTime))
    : [];
  const soldOut = soldOutValue === true || drop?.soldOut === true;
  // Mirror the server planner: a stale record whose end has already passed is not a usable future
  // choice even if its start field is malformed and appears to be ahead of us.
  const futureStages = soldOut ? [] : stages.filter(stage => stageIsUpcoming(stage, now));
  const hasAuthoritativeMintingState = typeof drop?.isMinting === 'boolean';

  const startedStages = stages.filter(stage => {
    const startMs = Number(stage?.startTime) * 1000;
    return Number.isFinite(startMs) && startMs <= now;
  });
  const soldOutStage = soldOut
    ? (startedStages.at(-1) || drop?.activeStage || null)
    : null;

  let liveStage = null;
  if (soldOut) {
    liveStage = null;
  } else if (hasAuthoritativeMintingState) {
    liveStage = drop.isMinting && drop.activeStage ? drop.activeStage : null;
  } else if (drop?.activeStage && stageIsOpenByTime(drop.activeStage, now)) {
    liveStage = drop.activeStage;
  } else if (stages.length) {
    liveStage = stages.find(stage => stage.schedulable !== false && stageIsOpenByTime(stage, now)) || null;
  } else if (!drop && stageIsOpenByTime({ startTime, endTime }, now)) {
    liveStage = { label:'Public mint', stageType:'public', startTime, endTime, priceWei:priceWeiPerItem };
  }

  const endedStages = stages.filter(stage => {
    const endMs = Number(stage?.endTime) * 1000;
    return Number.isFinite(endMs) && endMs > 0 && endMs <= now;
  });
  const endedStage = !soldOut && !liveStage && futureStages.length === 0
    ? (endedStages.at(-1) || null)
    : null;

  return { stages, futureStages, liveStage, soldOut, soldOutStage, endedStage, hasAuthoritativeMintingState };
}
