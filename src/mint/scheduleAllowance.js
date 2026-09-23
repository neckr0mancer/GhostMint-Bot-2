'use strict';

const { stageRequiresEligibilityCheck } = require('./scheduleStagePlanning');

const CONTRACT_CUMULATIVE = 'contract_cumulative';
const PER_STAGE = 'per_stage';
const UNKNOWN = 'unknown';

function asBigInt(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch { return null; }
}

function asMilliseconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stageStartMilliseconds(task) {
  return asMilliseconds(task?.allowanceStageStartAt) ?? asMilliseconds(task?.stageStartAt)
    ?? asMilliseconds(task?.mintTime);
}

function stageMatchesPublicDrop(stage, publicDrop) {
  const stageStart = Number(stage?.startTime ?? stage?.stageStartTime);
  const dropStart = Number(publicDrop?.startTime);
  if (!Number.isFinite(dropStart)) return false;
  if (stage?.directPublic) {
    const scheduled = Number(stage?.mintTime);
    const end = Number(publicDrop?.endTime);
    return !Number.isFinite(scheduled) || !Number.isFinite(end) || end <= 0 || scheduled <= end;
  }
  if (!Number.isFinite(stageStart) || stageStart !== dropStart) return false;
  const stageEnd = Number(stage?.endTime);
  const dropEnd = Number(publicDrop?.endTime);
  return !Number.isFinite(stageEnd) || stageEnd <= 0 || !Number.isFinite(dropEnd) || dropEnd <= 0
    || stageEnd === dropEnd;
}

function unknownEvidence({ stageStartAt = null, mintStats = null, verifiedAt = Date.now() } = {}) {
  return {
    allowanceScope: UNKNOWN,
    allowanceMaxPerWallet: null,
    allowanceMintedSnapshot: asBigInt(mintStats?.minterNumMinted)?.toString() ?? null,
    allowanceSource: mintStats ? 'seadrop:getMintStats' : null,
    allowanceVerifiedAt: mintStats ? verifiedAt : null,
    allowanceStageStartAt: asMilliseconds(stageStartAt),
  };
}

// A SeaDrop PublicDrop wallet maximum and ERC721SeaDrop.getMintStats share one proven scope:
// total mints by this wallet across the token contract. No OpenSea/display-only maximum is
// accepted here. A stage must also match the live on-chain PublicDrop window exactly before its
// maximum becomes a hard reservation boundary.
function buildSeaDropAllowanceEvidence({ stage, publicDrop, mintStats, verifiedAt = Date.now() } = {}) {
  const fallback = unknownEvidence({ stageStartAt:stage?.stageStartAt ?? (Number(stage?.startTime) * 1000),
    mintStats, verifiedAt });
  if (!stage || (!stage?.directPublic && stageRequiresEligibilityCheck(stage))
    || !stageMatchesPublicDrop(stage, publicDrop)) return fallback;
  const maximum = asBigInt(publicDrop?.maxTotalMintableByWallet);
  const minted = asBigInt(mintStats?.minterNumMinted);
  if (maximum === null || minted === null) return fallback;
  return {
    ...fallback,
    allowanceScope: CONTRACT_CUMULATIVE,
    allowanceMaxPerWallet: maximum.toString(),
    allowanceMintedSnapshot: minted.toString(),
    allowanceSource: 'seadrop:PublicDrop+getMintStats',
    allowanceVerifiedAt: verifiedAt,
    allowanceStageStartAt:Number(publicDrop.startTime) * 1000,
  };
}

// Some contracts expose an authoritative stage-local counter as well as that stage's cap. Keep
// that evidence distinct from SeaDrop's contract-wide getMintStats counter: a per-stage maximum
// must never subtract mints or reservations from a different phase. Callers must supply both the
// maximum and the CURRENT stage-local minted count from the same authoritative source; a display
// or marketplace maximum on its own deliberately stays unknown.
function buildPerStageAllowanceEvidence({ maximum, minted, source, stageStartAt = null,
  verifiedAt = Date.now() } = {}) {
  const parsedMaximum = asBigInt(maximum);
  const parsedMinted = asBigInt(minted);
  const evidenceSource = String(source || '').trim();
  if (parsedMaximum === null || parsedMinted === null || !evidenceSource) {
    return unknownEvidence({ stageStartAt });
  }
  return {
    allowanceScope: PER_STAGE,
    allowanceMaxPerWallet: parsedMaximum.toString(),
    allowanceMintedSnapshot: parsedMinted.toString(),
    allowanceSource:evidenceSource,
    allowanceVerifiedAt:verifiedAt,
    allowanceStageStartAt:asMilliseconds(stageStartAt),
  };
}

function allowanceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

// Called while the repository holds the wallet+chain+contract advisory lock. Every active task is
// considered, not only the selected stage. At each proven contract-cumulative boundary, all
// quantities reserved for that boundary or an earlier phase must fit beside the fresh on-chain
// minted count. This also re-checks later boundaries when an earlier task is inserted.
function enforceScheduleAllowanceEnvelope(existingTasks, candidate) {
  const tasks = [...existingTasks, candidate];
  const candidateAt = stageStartMilliseconds(candidate);
  let perStageResult = null;

  // A proven per-stage counter constrains only the exact persisted phase identity. It cannot
  // consume (or be consumed by) another stage, even when the other stage opened earlier. The
  // database's active-stage unique index normally limits this set to one task, but summing here
  // keeps the invariant correct for legacy rows and makes the rule explicit at the safety layer.
  if (candidate?.allowanceScope === PER_STAGE) {
    const maximum = asBigInt(candidate.allowanceMaxPerWallet);
    const currentMinted = asBigInt(candidate.allowanceMintedSnapshot);
    const stageKey = String(candidate.reservationStageKey || '').trim();
    if (maximum === null || currentMinted === null || !stageKey) {
      throw allowanceError('SCHEDULE_ALLOWANCE_UNAVAILABLE',
        'The wallet allowance for this mint stage could not be verified. Try again shortly.');
    }
    const reserved = tasks.reduce((sum, task) => {
      if (String(task?.reservationStageKey || '').trim() !== stageKey) return sum;
      const quantity = asBigInt(task?.qty);
      return quantity === null ? sum : sum + quantity;
    }, 0n);
    const total = currentMinted + reserved;
    if (total > maximum) {
      const candidateQuantity = asBigInt(candidate?.qty) ?? 0n;
      const reservedBeforeCandidate = reserved >= candidateQuantity
        ? reserved - candidateQuantity : reserved;
      const remaining = maximum > currentMinted + reservedBeforeCandidate
        ? maximum - currentMinted - reservedBeforeCandidate : 0n;
      throw allowanceError('SCHEDULE_ALLOWANCE_EXCEEDED',
        `This wallet can schedule ${remaining} more mint${remaining === 1n ? '' : 's'} in that stage.`, {
          scope:PER_STAGE,stageKey,maximum:maximum.toString(),minted:currentMinted.toString(),
          reserved:reservedBeforeCandidate.toString(),remaining:remaining.toString(),
        });
    }
    perStageResult = { enforced:true, minted:currentMinted.toString(), boundaries:1 };
  }

  const boundaries = tasks.filter(task => task?.allowanceScope === CONTRACT_CUMULATIVE
    && asBigInt(task.allowanceMaxPerWallet) !== null && stageStartMilliseconds(task) !== null);
  // Adding a later phase cannot consume capacity at an earlier boundary. Adding an earlier phase
  // can invalidate every later boundary, which is why the comparison is intentionally one-way.
  const affectedBoundaries = boundaries.filter(boundary => candidateAt === null
    || stageStartMilliseconds(boundary) >= candidateAt);
  if (!affectedBoundaries.length) return perStageResult || { enforced:false };

  // A per-stage counter is not interchangeable with a contract-cumulative counter. An adapter
  // that can prove both may pass allowanceContractMintedSnapshot transiently for this locked
  // calculation; it is intentionally not persisted in the single stage-counter column.
  const currentMinted = asBigInt(candidate?.allowanceContractMintedSnapshot
    ?? (candidate?.allowanceScope === PER_STAGE ? null : candidate?.allowanceMintedSnapshot));
  if (currentMinted === null) {
    throw allowanceError('SCHEDULE_ALLOWANCE_UNAVAILABLE',
      'The wallet allowance could not be refreshed while another scheduled stage depends on it. Try again shortly.');
  }

  const ordered = [...affectedBoundaries].sort((left, right) => stageStartMilliseconds(left) - stageStartMilliseconds(right));
  for (const boundary of ordered) {
    const boundaryAt = stageStartMilliseconds(boundary);
    const maximum = asBigInt(boundary.allowanceMaxPerWallet);
    const reserved = tasks.reduce((sum, task) => {
      const at = stageStartMilliseconds(task);
      const quantity = asBigInt(task?.qty);
      return at !== null && at <= boundaryAt && quantity !== null ? sum + quantity : sum;
    }, 0n);
    const total = currentMinted + reserved;
    if (total > maximum) {
      const candidateQuantity = candidateAt !== null && candidateAt <= boundaryAt
        ? (asBigInt(candidate?.qty) ?? 0n) : 0n;
      const reservedBeforeCandidate = reserved >= candidateQuantity ? reserved - candidateQuantity : reserved;
      const remaining = maximum > currentMinted + reservedBeforeCandidate
        ? maximum - currentMinted - reservedBeforeCandidate : 0n;
      throw allowanceError('SCHEDULE_ALLOWANCE_EXCEEDED',
        `This wallet can schedule ${remaining} more mint${remaining === 1n ? '' : 's'} before that stage.`, {
          maximum:maximum.toString(), minted:currentMinted.toString(),
          reserved:reservedBeforeCandidate.toString(), remaining:remaining.toString(),
          boundaryAt,
        });
    }
  }
  return { enforced:true, minted:currentMinted.toString(), boundaries:ordered.length };
}

module.exports = {
  CONTRACT_CUMULATIVE,
  PER_STAGE,
  UNKNOWN,
  buildPerStageAllowanceEvidence,
  buildSeaDropAllowanceEvidence,
  enforceScheduleAllowanceEnvelope,
  stageMatchesPublicDrop,
  stageStartMilliseconds,
  unknownEvidence,
};
