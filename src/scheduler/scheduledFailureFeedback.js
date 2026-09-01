'use strict';

function cleanReason(value) {
  return String(value || '')
    .replace(/^Request validation failed:\s*/i, '')
    .replace(/^(?:contractAddress|calldata|mintTime|quantity):?\s*/i, '')
    .trim();
}

function deliverySuffix(chainState) {
  if (chainState === 'mined') {
    return 'The transaction reached the chain and may have used a network fee.';
  }
  if (chainState === 'unknown') {
    return 'The transaction was not confirmed; check its status before trying again.';
  }
  return 'Nothing was sent.';
}

// One user-facing vocabulary for scheduler failures. Raw provider/OpenSea text is still retained
// in logs, but every surface receives a short explanation and an honest statement about whether a
// transaction reached the chain. Exhausted supply and wallet caps are expected drop conditions,
// not mysterious application failures, so they are warnings and not retryable as-is.
function scheduledFailureFeedback(rawReason, { chainState = 'not_sent' } = {}) {
  const cleaned = cleanReason(rawReason);
  const lower = cleaned.toLowerCase();
  const suffix = deliverySuffix(chainState);

  const walletLimit = !/(?:max(?:imum)? supply|sold[ -]?out)/i.test(cleaned)
    && /mintquantityexceedsmaxmintedperwallet|(?:wallet|address).{0,40}(?:mint|purchase).{0,20}(?:limit|maximum|max)|(?:limit|maximum|max|allowed).{0,25}(?:per wallet|per address)|(?:would hold|exceeding).{0,40}allowed per wallet|already (?:minted|claimed).{0,30}(?:maximum|max|limit)/i.test(cleaned);
  if (walletLimit) {
    return {
      code: 'WALLET_MINT_LIMIT_REACHED',
      message: `This wallet has reached this mint's limit. ${suffix}${chainState === 'not_sent' ? ' Use another eligible wallet.' : ''}`,
      severity: 'warning',
      terminal: true,
    };
  }

  const stageSoldOut = /mintquantityexceedsmaxtokensupplyforstage|stage.{0,30}(?:sold out|supply.{0,12}(?:exhausted|reached)|limit.{0,12}(?:reached|exceeded))/i.test(cleaned);
  if (stageSoldOut) {
    return {
      code: 'STAGE_SUPPLY_EXHAUSTED',
      message: `This mint stage sold out before the scheduled mint could run. ${suffix}`,
      severity: 'warning',
      terminal: true,
    };
  }

  const soldOut = /mintquantityexceedsmaxsupply|sold[ -]?out|supply.{0,20}(?:exhausted|reached)|max(?:imum)? supply.{0,20}(?:reached|exceeded)/i.test(cleaned);
  if (soldOut) {
    return {
      code: 'MINT_SOLD_OUT',
      message: `This mint sold out before the scheduled mint could run. ${suffix}`,
      severity: 'warning',
      terminal: true,
    };
  }

  if (/insufficient (?:funds|balance)|balance is below|cannot cover/i.test(lower)) {
    return {
      code: 'INSUFFICIENT_BALANCE',
      message: `This wallet does not have enough funds for the mint and network fee. ${suffix} Fund this wallet or use another wallet with enough balance.`,
      severity: 'warning',
      terminal: false,
    };
  }

  if (/^unknown error$/i.test(cleaned) || /^unknown scheduler failure$/i.test(cleaned)) {
    return {
      code: 'SCHEDULED_MINT_FAILED',
      message: `The scheduled mint could not be simulated — the contract rejected it without a clear reason. It may be sold out, not yet open, or the price is wrong. ${suffix} Check the collection's supply and stage timing.`,
      severity: 'warning',
      terminal: false,
    };
  }
  if (/missing revert data|no reason given/i.test(cleaned)) {
    return {
      code: 'SIMULATION_NO_REASON',
      message: `The contract rejected the mint without giving a reason. This often means it is sold out, not yet open, or the call was for the wrong stage. ${suffix}`,
      severity: 'warning',
      terminal: false,
    };
  }

  const fallback = cleaned || (chainState === 'mined'
    ? 'The transaction reverted on-chain.'
    : 'The scheduled mint could not run.');
  const alreadyExplainsDelivery = /nothing was (?:sent|broadcast)|transaction (?:reached|was sent|was broadcast|reverted)|on-chain/i.test(fallback);
  return {
    code: 'SCHEDULED_MINT_FAILED',
    message: `${fallback}${/[.!?]$/.test(fallback) ? '' : '.'}${alreadyExplainsDelivery ? '' : ` ${suffix}`}`,
    severity: 'error',
    terminal: false,
  };
}

async function deliverFailureSideEffects({ broadcast, recordActivity, notify, log = () => {} }) {
  if (typeof broadcast === 'function') {
    try { await Promise.resolve().then(broadcast); }
    catch (error) { log(`Scheduled failure dashboard delivery failed: ${error?.message || String(error || 'unknown error')}`); }
  }
  const operations = [
    ['activity', recordActivity],
    ['platform notification', notify],
  ].filter(([, operation]) => typeof operation === 'function');
  const results = await Promise.allSettled(operations.map(([, operation]) => Promise.resolve().then(operation)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const reason = result.reason?.message || String(result.reason || 'unknown error');
      log(`Scheduled failure ${operations[index][0]} delivery failed: ${reason}`);
    }
  });
}

module.exports = { cleanReason, deliverFailureSideEffects, scheduledFailureFeedback };
