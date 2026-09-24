'use strict';

const { createHash } = require('node:crypto');
const { CANONICAL_SEADROP_CORE_ADDRESS,SEADROP_MINT_SIGNATURE } = require('../mint/seaDropRegistry');
const { ARCHETYPE_INTERFACE,SEADROP_GATED_INTERFACE } = require('../mint/seaDropCall');

const TIME_POLICIES = Object.freeze(['approval', 'auto_within_limit']);
const PRICE_POLICIES = Object.freeze(['approval', 'allow_up_to_cap']);
const OPENSEA_VALIDATED_BUILDER_V1 = 'opensea_validated_builder_v1';
const OPENSEA_SEADROP_METHODS = new Set(['mintAllowList','mintSigned','mintAllowedTokenHolder']
  .map(name=>SEADROP_GATED_INTERFACE.getFunction(name).format('sighash')));
const OPENSEA_ARCHETYPE_METHODS = new Set(['mint','mintTo']
  .map(name=>ARCHETYPE_INTERFACE.getFunction(name).format('sighash')));

function finiteTime(value) {
  if(value===null||value===undefined||value==='')return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function wei(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const amount = BigInt(value);
    return amount >= 0n ? amount.toString() : null;
  } catch { return null; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

const CONFIGURATION_FIELDS = Object.freeze([
  'chain','contract','callTarget','method','standard','feeRecipient','stageIdentity',
  'authorization','configurationDigest','inviteKey','endTime','maxPerWallet','feeBps',
  'restrictFeeRecipients',
]);

// This is deliberately a small, display-safe description of the call. Proof bytes and signatures
// are never retained here: callers pass only presence/count text such as "proof present (3 items)".
// Keeping the same normalized object for hashing and review means the user can see what caused a
// configuration pause instead of being asked to approve two opaque SHA-256 values.
function configurationSummary(value = {}) {
  const summary={};
  for(const field of CONFIGURATION_FIELDS){
    const raw=value?.[field];
    if(raw===null||raw===undefined||raw==='')continue;
    if(field==='restrictFeeRecipients')summary[field]=Boolean(raw);
    else summary[field]=String(raw).slice(0,256);
  }
  // Only normalize values whose comparison is case-insensitive. Solidity function names and
  // provider stage identifiers may be case-sensitive, so preserve their exact display value.
  for(const field of ['chain','contract','callTarget','feeRecipient']){
    if(summary[field])summary[field]=summary[field].toLowerCase();
  }
  return Object.keys(summary).length?summary:null;
}

// Price and opening are intentionally excluded. They have independent policies and user-facing
// explanations; folding them into this hash would turn a permitted price decrease into an opaque
// "configuration changed" approval.
function configurationFingerprint(value = {}) {
  const normalized = configurationSummary({
    ...value,
    contract:value.contract || value.contractAddress,
    method:value.method || value.methodSignature,
  }) || {};
  // A stage's closing time is timing metadata, not a transaction-call authorization. Projects
  // commonly postpone the whole window by moving start and end together; hashing endTime here made
  // an otherwise permitted auto-reschedule look like an opaque call-configuration change. Keep it
  // in configurationSummary for the audit/review UI, but compare it separately below so a closing
  // shift is recorded without silently overriding the user's opening-time policy.
  delete normalized.endTime;
  return hash(normalized);
}

// A future gated phase cannot provide its wallet-specific proof/signature at schedule-creation
// time. Persist this narrow authorization envelope rather than a null baseline. It can only be
// replaced after the execution path has decoded and validated one of the explicit method/target
// pairs checked by canPromoteOpenSeaBuilder below.
function openSeaValidatedBuilderBaseline({chain,contract,stageIdentity}) {
  return configurationSummary({chain,contract,
    method:'supported mint selected at execution',standard:'OpenSea validated builder',
    stageIdentity,authorization:OPENSEA_VALIDATED_BUILDER_V1});
}

function canPromoteOpenSeaBuilder(previous,observed,authorization) {
  if(authorization!==OPENSEA_VALIDATED_BUILDER_V1
    ||previous?.configSummary?.authorization!==OPENSEA_VALIDATED_BUILDER_V1){
    return false;
  }
  const before=previous.configSummary;
  const after=observed.configSummary;
  if(!['chain','contract','stageIdentity'].every(field=>(before[field]??null)===(after?.[field]??null))){
    return false;
  }
  const target=String(after.callTarget||'').toLowerCase();
  const contract=String(after.contract||'').toLowerCase();
  const canonical=CANONICAL_SEADROP_CORE_ADDRESS.toLowerCase();
  const stableDigest=/^[0-9a-f]{64}$/.test(String(after.configurationDigest||''));
  const seaDropPublic=target===canonical&&after.standard==='SeaDrop'
    &&after.method===SEADROP_MINT_SIGNATURE;
  const seaDropGated=target===canonical&&String(after.standard||'').startsWith('SeaDrop ')
    &&OPENSEA_SEADROP_METHODS.has(after.method)&&stableDigest;
  const archetype=target===contract&&after.standard==='Archetype ERC-721A'
    &&OPENSEA_ARCHETYPE_METHODS.has(after.method)&&stableDigest&&Boolean(after.inviteKey);
  return seaDropPublic||seaDropGated||archetype;
}

function snapshotFromTask(task) {
  return {
    openingAt:finiteTime(task.acceptedOpeningAt ?? task.mintTime),
    priceWeiPerItem:wei(task.acceptedPriceWeiPerItem),
    configFingerprint:task.acceptedConfigFingerprint || null,
    configSummary:configurationSummary(task.acceptedConfigSummary),
  };
}

function normalizeObservation(observation = {}) {
  const configSummary=configurationSummary(observation.configSummary);
  return {
    openingAt:finiteTime(observation.openingAt),
    priceWeiPerItem:wei(observation.priceWeiPerItem),
    // Never persist or ask a user to approve an opaque fingerprint. Current execution paths all
    // provide the safe summary; an old/incomplete caller simply leaves configuration unobserved.
    configFingerprint:configSummary
      ?(observation.configFingerprint || configurationFingerprint(configSummary)):null,
    configSummary,
    stageMissing:observation.stageMissing===true,
    source:observation.source ? String(observation.source).slice(0, 80) : 'runtime',
  };
}

function evaluateScheduleObservation(task, observation,
  { now = Date.now(),allowConfigurationBaseline = false,
    validatedConfigurationPromotion = null } = {}) {
  const previous = snapshotFromTask(task);
  const observed = normalizeObservation(observation);
  const changes = [];
  const reviews = [];

  if(observed.stageMissing){
    changes.push({kind:'stage_removed'});
    reviews.push('The selected mint stage is no longer present in the project schedule.');
  }

  if (observed.openingAt !== null && previous.openingAt !== null
    && observed.openingAt !== previous.openingAt) {
    const direction = observed.openingAt > previous.openingAt ? 'later' : 'earlier';
    changes.push({ kind:'opening', direction, from:previous.openingAt, to:observed.openingAt });
    if (direction === 'earlier') {
      reviews.push('The project moved this stage earlier. GhostMint will not spend earlier than you approved.');
    } else {
      const original = finiteTime(task.originalOpeningAt ?? task.mintTime);
      const maximum = Number(task.maxOpeningDelayMs);
      const totalDelay = original === null ? Number.POSITIVE_INFINITY : observed.openingAt - original;
      const withinDelay = task.timeChangePolicy === 'auto_within_limit'
        && Number.isFinite(maximum) && maximum >= 1_000 && totalDelay <= maximum;
      if (!withinDelay) reviews.push(task.timeChangePolicy === 'auto_within_limit'
        ? 'The new opening is later than the delay limit you approved.'
        : 'The project postponed this stage and automatic rescheduling is off.');
    }
  }

  if (observed.priceWeiPerItem !== null && previous.priceWeiPerItem === null) {
    const to = BigInt(observed.priceWeiPerItem);
    changes.push({ kind:'price', direction:to > 0n ? 'higher' : 'baseline', from:null,
      to:to.toString() });
    if (to > 0n) reviews.push('The schedule did not have a verified price before now.');
  } else if (observed.priceWeiPerItem !== null && previous.priceWeiPerItem !== null
    && observed.priceWeiPerItem !== previous.priceWeiPerItem) {
    const from = BigInt(previous.priceWeiPerItem);
    const to = BigInt(observed.priceWeiPerItem);
    const direction = to > from ? 'higher' : 'lower';
    changes.push({ kind:'price', direction, from:from.toString(), to:to.toString() });
    if (direction === 'higher') {
      const cap = wei(task.maxPriceWeiPerItem);
      const withinCap = task.priceChangePolicy === 'allow_up_to_cap'
        && cap !== null && to <= BigInt(cap);
      if (!withinCap) reviews.push(task.priceChangePolicy === 'allow_up_to_cap'
        ? 'The new mint price is above the price limit you approved.'
        : 'The mint price increased and automatic price changes are off.');
    }
  }

  if (observed.configFingerprint && previous.configFingerprint
    && observed.configFingerprint !== previous.configFingerprint) {
    changes.push({ kind:'configuration', from:previous.configFingerprint,
      to:observed.configFingerprint,fromSummary:previous.configSummary,toSummary:observed.configSummary });
    if(!canPromoteOpenSeaBuilder(previous,observed,validatedConfigurationPromotion)){
      reviews.push('The transaction target or mint method changed.');
    }
  } else if (observed.configFingerprint && !previous.configFingerprint) {
    changes.push({ kind:'configuration_baseline', from:null,
      to:observed.configFingerprint,toSummary:observed.configSummary });
    // Creation may explicitly establish a baseline in the same transaction that creates a task.
    // A legacy/runtime task with no baseline must fail closed: otherwise the first worker could
    // silently authorize whichever target and method happened to be observed first.
    if(!allowConfigurationBaseline){
      reviews.push('This schedule did not have a verified transaction configuration before now.');
    }
  }

  // Preserve closing-time drift as an explicit audit fact even though it is deliberately excluded
  // from the spend-critical configuration fingerprint. When an opening and closing move together,
  // the opening policy still decides whether to auto-reschedule or ask; an end-only shift is safe
  // to accept because it cannot make GhostMint spend earlier or increase transaction value.
  const previousEnd=previous.configSummary?.endTime??null;
  const observedEnd=observed.configSummary?.endTime??null;
  if(observed.configFingerprint&&previous.configFingerprint
    &&observed.configFingerprint===previous.configFingerprint
    &&previousEnd!==null&&observedEnd!==null&&String(previousEnd)!==String(observedEnd)){
    changes.push({kind:'closing',from:String(previousEnd),to:String(observedEnd)});
  }

  const deadline = finiteTime(task.eligibilityDeadline);
  const observedOpening = observed.openingAt;
  if (observedOpening !== null && deadline !== null && observedOpening >= deadline) {
    return result('expired', previous, observed, changes,
      ['The new opening is outside this schedule\'s safety window.'], task);
  }
  if (!changes.length) return result('unchanged', previous, observed, changes, [], task);
  if (reviews.length) return result('awaiting_approval', previous, observed, changes, reviews, task);
  const laterOpening = changes.some(change => change.kind === 'opening' && change.direction === 'later');
  // `mintTime` is the earliest execution time the user approved. A collection can move its stage
  // from 10:00 to 10:05 while the user deliberately chose 10:30; that is a stage change worth
  // recording, but it must never pull the spend forward to 10:05. Only re-arm when the new live
  // opening is later than both now and the already-approved execution time.
  const approvedAttempt = finiteTime(task.mintTime);
  const needsLaterAttempt = laterOpening && observedOpening > now
    && (approvedAttempt === null || observedOpening > approvedAttempt);
  return result(needsLaterAttempt ? 'auto_rescheduled' : 'accepted',
    previous, observed, changes, [], task);
}

function result(action, previous, observed, changes, reasons, task) {
  const kinds = [...new Set(changes.map(change => change.kind))];
  const payload = { previous, observed, changes, reasons, taskId:task.id };
  return {
    action, previous, observed, changes, kinds, reasons,
    eventFingerprint:hash(payload),
    reason:reasons.join(' ') || changeSummary(changes),
  };
}

function changeSummary(changes) {
  const kinds = [...new Set(changes.map(change => change.kind))];
  if (!kinds.length) return 'No schedule change detected.';
  if (kinds.length === 1 && kinds[0] === 'opening') return 'The stage opening changed.';
  if (kinds.length === 1 && kinds[0] === 'price') return 'The mint price changed.';
  if (kinds.length === 1 && kinds[0] === 'configuration') return 'The mint configuration changed.';
  if (kinds.length === 1 && kinds[0] === 'closing') return 'The stage closing time changed.';
  return `The ${kinds.join(', ').replace(/, ([^,]*)$/, ' and $1')} changed together.`;
}

module.exports = {
  OPENSEA_VALIDATED_BUILDER_V1,
  PRICE_POLICIES,
  TIME_POLICIES,
  configurationFingerprint,
  configurationSummary,
  evaluateScheduleObservation,
  normalizeObservation,
  openSeaValidatedBuilderBaseline,
  snapshotFromTask,
};
