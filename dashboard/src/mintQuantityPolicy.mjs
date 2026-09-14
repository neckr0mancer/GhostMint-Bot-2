export const APP_MINT_QUANTITY_MAX=100;

// `detectMintContract` exposes one normalized, top-level maxPerWallet value. That is the contract
// policy consumed by every mint surface. OpenSea's nested stage metadata is display information
// and is not a substitute: some launchpads report a stage/order size of 1 there while their mint
// call permits a much larger per-wallet amount. When the server cannot prove a smaller cap, keep
// the request schema's safe ceiling of 100 and let the real simulation reject an ineligible call.
export function mintQuantityPolicy(result){
  const parsed=Number(result?.maxPerWallet);
  const detected=Number.isFinite(parsed)&&parsed>0;
  return {
    max:detected?Math.min(APP_MINT_QUANTITY_MAX,Math.floor(parsed)):APP_MINT_QUANTITY_MAX,
    detected,
  };
}

// Contract detection returns the total native value for the requested quantity because that is
// useful to callers that only display a quote. Dashboard forms display/edit a PER-ITEM price, while
// the mint encoder expects the total native value for the complete call. Keep both boundaries
// explicit so a quantity of 3 can neither underpay with one unit nor accidentally multiply a
// three-item quote twice.
//
// New servers expose priceWeiPerItem directly. The exact division fallback keeps local dashboards
// compatible with an older deployed API during a rolling deploy; a non-divisible value is refused
// rather than rounded into a different payment.
export function mintDetectionPricePerItem(result,requestedQuantity=1){
  const explicit=result?.priceWeiPerItem;
  if(explicit!==undefined&&explicit!==null&&/^\d+$/.test(String(explicit)))return String(explicit);
  if(result?.valueWei===undefined||result?.valueWei===null||!/^\d+$/.test(String(result.valueWei)))return null;
  const quantity=Number(requestedQuantity);
  if(!Number.isSafeInteger(quantity)||quantity<1)return null;
  const total=BigInt(result.valueWei);
  const divisor=BigInt(quantity);
  return total%divisor===0n?(total/divisor).toString():null;
}

export function mintTotalValueWei(priceWeiPerItem,requestedQuantity=1){
  if(priceWeiPerItem===undefined||priceWeiPerItem===null||!/^\d+$/.test(String(priceWeiPerItem)))return null;
  const quantity=Number(requestedQuantity);
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>APP_MINT_QUANTITY_MAX)return null;
  return (BigInt(priceWeiPerItem)*BigInt(quantity)).toString();
}
