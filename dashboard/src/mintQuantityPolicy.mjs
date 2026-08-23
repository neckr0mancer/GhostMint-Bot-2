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
