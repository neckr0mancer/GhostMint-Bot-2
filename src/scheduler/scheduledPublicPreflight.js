'use strict';

const { isAddress } = require('ethers');

const PUBLIC_STAGE_RECHECK_MS = 250;

function asWhole(value, fallback = 0n) {
  try { return BigInt(value); }
  catch { return fallback; }
}

function sameAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

// SeaDrop's PublicDrop is mutable right up to launch. The discovery cache is useful for the
// core address, but its fee recipient must not be treated as permanent: projects can replace the
// allowed recipient after a schedule was created. Prefer the cached value only when it is still
// valid under the live rules, otherwise move to the first currently allowed address.
function liveFeeRecipient({ cachedFeeRecipient, allowedFeeRecipients = [], restrictFeeRecipients,
  walletAddress }) {
  const allowed = allowedFeeRecipients.filter(isAddress);
  if (restrictFeeRecipients) {
    if (isAddress(cachedFeeRecipient) && allowed.some(value => sameAddress(value, cachedFeeRecipient))) {
      return cachedFeeRecipient;
    }
    return allowed[0] || null;
  }
  if (isAddress(cachedFeeRecipient)) return cachedFeeRecipient;
  return allowed[0] || (isAddress(walletAddress) ? walletAddress : null);
}

// A schedule wakes according to wall time, while the contract enforces block.timestamp. At an
// exact advertised opening the latest block can still be one or two seconds behind the computer's
// clock. Treat that as a durable phase wait, not a failed mint, and check again shortly/next block.
function publicStageClock({ chainTimeMs, wallTimeMs, startTime, endTime, deadlineMs }) {
  const startMs = Number(startTime) * 1_000;
  const endMs = Number(endTime) * 1_000;
  if (!Number.isFinite(chainTimeMs)) {
    return { status:'error', code:'CHAIN_TIME_UNAVAILABLE',
      reason:'The chain time could not be verified, so GhostMint did not try this mint.' };
  }
  if (!Number.isFinite(startMs) || startMs <= 0 || !Number.isFinite(endMs) || endMs <= 0) {
    return { status:'error', code:'PUBLIC_STAGE_UNVERIFIED',
      reason:'An active public mint window could not be verified on chain.' };
  }
  if (chainTimeMs < startMs) {
    return { status:'wait', code:'CHAIN_NOT_AT_PUBLIC_OPEN',
      retryAt:Math.min(Number(deadlineMs), Number(wallTimeMs) + PUBLIC_STAGE_RECHECK_MS),
      reason:`The chain has not reached the public opening yet (${new Date(startMs).toISOString()}).` };
  }
  // SeaDrop's contract rejects only when block.timestamp is greater than endTime, so the exact
  // final timestamp remains valid and must not be discarded one block early.
  if (chainTimeMs > endMs) {
    return { status:'error', code:'PUBLIC_STAGE_ENDED',
      reason:'The public mint stage ended before this wallet could mint.' };
  }
  return { status:'ready', chainTimeMs, startMs, endMs };
}

function publicMintCapacity({ quantity, publicDrop, mintStats }) {
  const qty = asWhole(quantity);
  const maxPerWallet = asWhole(publicDrop?.maxTotalMintableByWallet);
  if (qty < 1n) {
    return { status:'error', code:'INVALID_QUANTITY', reason:'The scheduled quantity must be at least one.' };
  }
  if (maxPerWallet === 0n || qty > maxPerWallet) {
    return { status:'error', code:'WALLET_MINT_LIMIT_REACHED',
      reason:`This public stage allows at most ${maxPerWallet} mint${maxPerWallet === 1n ? '' : 's'} per wallet, but this schedule requests ${qty}.` };
  }
  if (!mintStats) return { status:'ready', remaining:null };
  const minted = asWhole(mintStats.minterNumMinted);
  const supply = asWhole(mintStats.currentTotalSupply);
  const maxSupply = asWhole(mintStats.maxSupply);
  const remaining = maxPerWallet > minted ? maxPerWallet - minted : 0n;
  if (minted + qty > maxPerWallet) {
    return { status:'error', code:'WALLET_MINT_LIMIT_REACHED', remaining,
      reason:`This wallet already minted ${minted} and has ${remaining} mint${remaining === 1n ? '' : 's'} left for this public stage; the schedule requests ${qty}.` };
  }
  if (supply + qty > maxSupply) {
    const collectionRemaining = maxSupply > supply ? maxSupply - supply : 0n;
    return { status:'error', code:'MINT_SOLD_OUT', remaining,
      reason:`Only ${collectionRemaining} NFT${collectionRemaining === 1n ? '' : 's'} remain${collectionRemaining === 1n ? 's' : ''}, but this schedule requests ${qty}.` };
  }
  return { status:'ready', remaining, minted, currentTotalSupply:supply, maxSupply };
}

function opaquePublicSimulationReason({ capacity }) {
  const allowance = capacity?.remaining === null || capacity?.remaining === undefined
    ? 'the wallet limit could not be read'
    : `this wallet had ${capacity.remaining} mint${capacity.remaining === 1n ? '' : 's'} left`;
  return `GhostMint verified that the public stage was open, the fee recipient was approved, and ${allowance}, but the contract rejected the call without identifying another rule. Nothing was sent.`;
}

module.exports = {
  PUBLIC_STAGE_RECHECK_MS,
  liveFeeRecipient,
  opaquePublicSimulationReason,
  publicMintCapacity,
  publicStageClock,
};
