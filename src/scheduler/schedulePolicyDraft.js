const { formatEther, parseEther } = require('ethers');
const { LIMITS } = require('../validation/domain');

const MAX_PRICE_WEI = parseEther(String(LIMITS.priceEth));

function expectedPriceWei(data = {}) {
  if (data.expectedPriceWeiPerItem !== null && data.expectedPriceWeiPerItem !== undefined) {
    try { return BigInt(data.expectedPriceWeiPerItem); } catch { return null; }
  }
  if (data.priceETH === null || data.priceETH === undefined || data.priceETH === '') return null;
  try { return parseEther(String(data.priceETH)); } catch { return null; }
}

function canFollowTimeChanges(data = {}) {
  if (String(data.stageUuid || '').trim()) return true;
  const type = String(data.stageType || '').trim().toLowerCase()
    .replace(/[\s-]+/g, '_');
  return data.viaOpenSea !== true && type === 'seadrop_public_drop';
}

function toggleAutoReschedule(data = {}) {
  if (!canFollowTimeChanges(data)) return { ...data, autoReschedule:false };
  return { ...data, autoReschedule: data.autoReschedule !== true };
}

function clearPriceCap(data = {}) {
  const next = { ...data, acceptPriceChanges: false };
  delete next.maxPriceWeiPerItem;
  return next;
}

function setPriceCap(data = {}, rawValue) {
  let cap;
  try { cap = parseEther(String(rawValue ?? '').trim()); }
  catch { return { ok:false, message:'Enter a valid chain-currency amount with no more than 18 decimal places.' }; }
  if (cap <= 0n) return { ok:false, message:'The maximum price must be greater than zero.' };
  if (cap > MAX_PRICE_WEI) {
    return { ok:false, message:`The maximum price must be ${LIMITS.priceEth.toLocaleString('en-US')} or less.` };
  }
  const current = expectedPriceWei(data);
  if (current !== null && cap < current) {
    return { ok:false,
      message:`The maximum cannot be below the current price (${formatEther(current)}).` };
  }
  return { ok:true, data:{ ...data, acceptPriceChanges:true, maxPriceWeiPerItem:cap.toString() } };
}

function taskPolicyInput(data = {}) {
  const value = {
    autoReschedule:data.autoReschedule === true && canFollowTimeChanges(data),
    acceptPriceChanges:data.acceptPriceChanges === true,
    expectedPriceWeiPerItem:data.expectedPriceWeiPerItem,
  };
  if (value.acceptPriceChanges && data.maxPriceWeiPerItem !== null
    && data.maxPriceWeiPerItem !== undefined) {
    value.maxPriceWeiPerItem=String(data.maxPriceWeiPerItem);
  }
  return value;
}

module.exports={canFollowTimeChanges,clearPriceCap,expectedPriceWei,setPriceCap,taskPolicyInput,
  toggleAutoReschedule};
