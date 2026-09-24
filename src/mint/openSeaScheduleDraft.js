'use strict';

const { formatEther } = require('ethers');
const { stageRequiresEligibilityCheck } = require('./scheduleStagePlanning');

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function humanizeStageType(value) {
  const normalized = text(value).replace(/[_-]+/g, ' ');
  return normalized ? normalized.replace(/\b\w/g, letter => letter.toUpperCase()) : 'OpenSea phase';
}

function openSeaPhaseTaskName(mintFlowData, stage) {
  const phase = text(stage?.label) || humanizeStageType(stage?.stageType ?? stage?.stage_type);
  return mintFlowData?.collection?.name ? `${mintFlowData.collection.name} — ${phase}` : phase;
}

function openSeaPhaseEligibilityDeadline(mintFlowData, stage) {
  const startTime = Number(stage?.startTime);
  if (!Number.isFinite(startTime)) return null;
  const cap = startTime + 24 * 60 * 60;
  // earliest_eligible may move from an ineligible allowlist into a following public phase. Use the
  // latest advertised end at/after the chosen phase, but never chase a project indefinitely. A
  // reachable later phase with no advertised end must keep the task alive into that phase; using
  // only the earlier allowlist's end would expire it before the public opening we promised to try.
  const reachable = (mintFlowData?.drop?.stages || []).filter(candidate => {
    const candidateStart = Number(candidate?.startTime);
    // A phase opening exactly at the deadline is not reachable: the worker treats `now >=
    // deadline` as terminal before it may execute. Do not promise that phase in the task window.
    return Number.isFinite(candidateStart) && candidateStart >= startTime && candidateStart < cap;
  });
  const hasOpenEndedReachableStage = reachable.some(candidate => {
    const endTime = Number(candidate?.endTime);
    return !Number.isFinite(endTime) || endTime <= Number(candidate?.startTime);
  });
  const advertisedEnds = reachable
    .map(candidate => Number(candidate?.endTime))
    .filter(endTime => Number.isFinite(endTime) && endTime > startTime);
  const latest = hasOpenEndedReachableStage || !advertisedEnds.length ? cap : Math.max(...advertisedEnds);
  return new Date(Math.min(latest, cap) * 1000).toISOString();
}

function buildOpenSeaScheduleTaskData(mintFlowData, stage) {
  if (!mintFlowData || !stage || !Number.isFinite(Number(stage.startTime))) return null;
  const requiresEligibilityCheck = stageRequiresEligibilityCheck(stage);
  const viaOpenSea = !mintFlowData.isSeaDrop || requiresEligibilityCheck;
  const detectedPrice = stage.priceWei !== null && stage.priceWei !== undefined
    ? Number(formatEther(BigInt(stage.priceWei)))
    : (Number.isFinite(stage.priceETH) ? stage.priceETH : undefined);
  return {
    contractAddress: mintFlowData.contractAddress,
    chain: mintFlowData.chain,
    isSeaDrop: Boolean(mintFlowData.isSeaDrop),
    priceETH: viaOpenSea ? 0 : detectedPrice,
    // Preserve the exact per-item price shown in the phase picker even when OpenSea must build
    // the eventual calldata. The command service deliberately stores priceETH=0 for that builder
    // route, so this wei baseline is what prevents a paid stage from being mistaken for a free one.
    expectedPriceWeiPerItem: stage.priceWei !== null && stage.priceWei !== undefined
      ? String(stage.priceWei) : null,
    priceUnknown: !viaOpenSea && detectedPrice === undefined,
    viaOpenSea,
    collection: mintFlowData.collection,
    drop: mintFlowData.drop,
    schedulePlan: mintFlowData.schedulePlan || null,
    stageUuid: stage.uuid || null,
    stageLabel: stage.label || null,
    stageType: stage.stageType ?? stage.stage_type ?? null,
    eligibilityMode: requiresEligibilityCheck ? 'earliest_eligible' : 'specific_stage',
    eligibilityDeadline: openSeaPhaseEligibilityDeadline(mintFlowData, stage),
    mintTime: new Date(Number(stage.startTime) * 1000).toISOString(),
    name: openSeaPhaseTaskName(mintFlowData, stage),
    maxPerWallet: stage.maxPerWallet ?? mintFlowData.maxPerWallet,
  };
}

module.exports = {
  buildOpenSeaScheduleTaskData,
  humanizeStageType,
  openSeaPhaseEligibilityDeadline,
  openSeaPhaseTaskName,
};
