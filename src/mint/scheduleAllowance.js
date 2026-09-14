'use strict';

const { stageRequiresEligibilityCheck } = require('./scheduleStagePlanning');

const CONTRACT_CUMULATIVE = 'contract_cumulative';
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
  const boundaries = tasks.filter(task => task?.allowanceScope === CONTRACT_CUMULATIVE
    && asBigInt(task.allowanceMaxPerWallet) !== null && stageStartMilliseconds(task) !== null);
  // Adding a later phase cannot consume capacity at an earlier boundary. Adding an earlier phase
  // can invalidate every later boundary, which is why the comparison is intentionally one-way.
  const affectedBoundaries = boundaries.filter(boundary => candidateAt === null
    || stageStartMilliseconds(boundary) >= candidateAt);
  if (!affectedBoundaries.length) return { enforced:false };

  const currentMinted = asBigInt(candidate?.allowanceMintedSnapshot);
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
  UNKNOWN,
  buildSeaDropAllowanceEvidence,
  enforceScheduleAllowanceEnvelope,
  stageMatchesPublicDrop,
  stageStartMilliseconds,
  unknownEvidence,
};
