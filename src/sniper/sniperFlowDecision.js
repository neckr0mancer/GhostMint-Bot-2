// Platform-agnostic "what's next" decisions for the guided sniper-creation flow. Both Telegram's
// server.js and Discord's discordBot.js call these instead of each re-deriving the same branching
// by hand -- same reasoning as src/mint/mintFlowDecision.js, which this mirrors in shape (an
// auto-skip decision chain, not src/social/watchRuleFlowDecision.js's flat field-list walker),
// since this flow needs conditional skipping the same way mint_guided's wallet step does.
//
// Pure by design: every function here takes already-known data (and, where the decision depends
// on it, an already-fetched wallet list) and returns { step, data } -- never touching flow-state
// storage, rendering, or validation. Callers own all of that; a target address's format, for
// instance, is validated at the call site before ever reaching afterTarget here, the same way
// mint_guided validates/resolves a contract address before calling into mintFlowDecision at all.
//
// This is a copy-mode sniper's own shape: label -> target wallet to copy -> chain -> which of the
// user's own wallets executes the copy -> fee tolerance & caps -> confirm. Every field left out of
// this flow (valueMode, gasBoostPercent, cooldownMs, maxAttempts, contract allow/deny lists,
// sourceConfirmations) already has a working default in validateSniper -- this only ever asks for
// what has none, plus the one combined tolerance/caps step, matching the same scope line
// mint_guided's own gas-tolerance step draws against the rest of governance config.

// Mirrors validateSniper's own `??` defaults (src/validation/domain.js) so both platforms'
// "here's the default" display text reads from one source instead of copy-pasting the numbers.
const DEFAULTS = Object.freeze({ maxGasGwei: 200, maxValueETH: 0.1, dailySpendingCapETH: 0.25 });

function afterLabel({ data }) {
  return { step: 'awaiting_target', data };
}

function afterTarget({ data }) {
  return { step: 'awaiting_chain', data };
}

// A single owned wallet has nothing to pick between -- same reasoning as
// mintFlowDecision.afterQuantity's single-wallet auto-select.
function afterChain({ data, wallets }) {
  if (wallets.length === 1) {
    return afterWalletSelection({ data: { ...data, walletLabel: wallets[0].label } });
  }
  return { step: 'awaiting_wallet', data };
}

function afterWalletSelection({ data }) {
  return { step: 'awaiting_tolerance', data };
}

// After the fee-tolerance/caps step (defaults accepted as-is, or one/more typed by hand). Always
// lands on confirm -- there is no skipConfirm/one-shot mode for sniper creation the way mintnow
// has for mint.
function afterTolerance({ data, maxGasGwei, maxValueETH, dailySpendingCapETH }) {
  return { step: 'awaiting_confirm', data: { ...data, maxGasGwei, maxValueETH, dailySpendingCapETH } };
}

module.exports = { DEFAULTS, afterLabel, afterTarget, afterChain, afterWalletSelection, afterTolerance };
