// Platform-agnostic "what's next" decisions for the guided mint flow (Section M's one-shot-popup
// collapse). Both Telegram's server.js and Discord's guided flow call these instead of each
// re-deriving the same branching by hand, so a future change to this decision tree can't silently
// diverge between platforms the way two independently hand-mirrored copies eventually would.
//
// Pure by design: every function here takes already-known data (and, where the decision depends
// on it, an already-fetched wallet list) and returns { step, data } -- never touching flow-state
// storage, rendering, or transaction execution. Callers own all of that. 'execute' is a valid
// returned step: it means "nothing left to ask, run the mint now," and it's the caller's job to
// actually do that and render the result, matching how it renders every other step.
//
// This intentionally covers only mint_guided's chain (details -> quantity -> wallet -> price ->
// confirm/execute). task_guided's schedule flow has its own shape (it always wants a name and
// never auto-selects a wallet the same way) and is out of scope here.

// After contract details resolve: a contract allowing more than 1 per wallet asks how many first;
// a max of 1 (or unknown) has nothing to ask, so it flows straight into the quantity decision with
// quantity defaulted to 1 -- unchanged from what advanceFromDetails already did before this was
// extracted.
function afterDetails({ data, wallets }) {
  if (Number(data.maxPerWallet) > 1) return { step: 'awaiting_quantity', data };
  return afterQuantity({ data: { ...data, quantity: 1 }, wallets });
}

// After a quantity is chosen (or defaulted to 1 above): a single wallet has nothing to pick
// between -- asking anyway is a tap that teaches the user nothing -- so /mint (not /batch) with
// exactly one owned wallet auto-selects it and moves straight on. `data` must already include
// `quantity`.
function afterQuantity({ data, wallets }) {
  if (!data.multi && wallets.length === 1) {
    return afterWalletSelection({ data: { ...data, selectedWallets: [wallets[0].label] } });
  }
  return { step: 'awaiting_wallet', data };
}

// Once wallet(s) are picked (auto-selected above, or chosen by the user): price was already
// resolved back when the contract was detected, so this only needs to decide whether that
// resolution actually found a price (ask for one by hand) or not (move on to whatever's next).
// `data` must already include `selectedWallets`.
function afterWalletSelection({ data }) {
  if (data.priceUnknown) return { step: 'awaiting_price', data };
  return afterPriceKnown({ data });
}

// After a price is resolved by hand (typed, or an OpenSea-floor accept). priceUnknown is
// deliberately forced back to true here even though a price now exists -- it's overloaded by the
// confirm screen to mean "user-supplied, not read from the contract" for display purposes, not
// "still missing." Preserved exactly as advanceFromPriceResolved already behaved.
function afterPriceResolved({ data, priceETH }) {
  return afterPriceKnown({ data: { ...data, priceETH, priceUnknown: true } });
}

// Once the price is settled (known from the contract, or just typed/accepted above): a batch mint
// (multi) asks for a per-batch gas tolerance next -- a single /mint never does, since a lone
// transaction's cost is already bounded by the account's own governance gas ceiling and a second
// prompt would just be a tap that teaches the user nothing. skipConfirm (the /mintnow bypass mode)
// only ever applies to single mints -- see startMintFlow -- so it's never reachable for a batch
// here regardless of check order.
function afterPriceKnown({ data }) {
  if (data.multi) return { step: 'awaiting_gastolerance', data };
  if (data.skipConfirm) return { step: 'execute', data };
  return { step: 'awaiting_confirm', data };
}

// After a batch's gas tolerance is set (an explicit gwei cap, or "no extra limit" which leaves
// maxGasGwei unset and relies on the account's own governance gas ceiling same as before this
// step existed). Always lands on confirm -- skipConfirm never applies to a batch (see above).
function afterGasToleranceResolved({ data, maxGasGwei }) {
  return { step: 'awaiting_confirm', data: { ...data, maxGasGwei } };
}

module.exports = { afterDetails, afterQuantity, afterWalletSelection, afterPriceResolved, afterGasToleranceResolved };
