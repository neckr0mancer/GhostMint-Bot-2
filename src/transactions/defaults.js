const { parseEther } = require('ethers');

const DEFAULT_MAX_TRANSACTION_VALUE_WEI = parseEther('0.1');
const DEFAULT_DAILY_SPENDING_BUDGET_WEI = parseEther('0.25');
const DEFAULT_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

const CHAIN_POLICY_DEFAULTS = Object.freeze({
  ethereum: Object.freeze({ gasCeilingGwei: 200, requiredConfirmations: 12 }),
  base: Object.freeze({ gasCeilingGwei: 5, requiredConfirmations: 10 }),
  arbitrum: Object.freeze({ gasCeilingGwei: 5, requiredConfirmations: 20 }),
  polygon: Object.freeze({ gasCeilingGwei: 500, requiredConfirmations: 128 }),
  // Robinhood Chain is an Arbitrum Orbit chain running Arbitrum Nitro with BoLD dispute resolution
  // (per docs.robinhood.com/chain) -- the same fraud-proof/challenge-window mechanics as the existing
  // arbitrum entry above, so mirrors its values rather than guessing. Newer and less battle-tested
  // than Arbitrum mainnet itself, so treat these as a conservative starting point to revisit once the
  // chain has an established track record, not a settled judgment.
  robinhood: Object.freeze({ gasCeilingGwei: 5, requiredConfirmations: 20 }),
  // Same PoS consensus/finality shape as ethereum mainnet, so the same confirmation depth applies.
  // Not user-selectable (see the matching comment in src/config/index.js) -- kept only so the
  // Milestone 14 live acceptance run still has a policy default when temporarily opted into.
  sepolia: Object.freeze({ gasCeilingGwei: 200, requiredConfirmations: 12 }),
});

function defaultPolicy(chain) {
  const chainDefaults = CHAIN_POLICY_DEFAULTS[chain];
  if (!chainDefaults) throw new Error(`No transaction policy defaults for chain ${chain}`);
  return {
    simulationEnabled: true,
    gasCeilingGwei: chainDefaults.gasCeilingGwei,
    maxTransactionValueWei: DEFAULT_MAX_TRANSACTION_VALUE_WEI,
    dailySpendingBudgetWei: DEFAULT_DAILY_SPENDING_BUDGET_WEI,
    requiredConfirmations: chainDefaults.requiredConfirmations,
    transactionTimeoutMs: DEFAULT_TRANSACTION_TIMEOUT_MS,
  };
}

module.exports = {
  CHAIN_POLICY_DEFAULTS,
  DEFAULT_DAILY_SPENDING_BUDGET_WEI,
  DEFAULT_MAX_TRANSACTION_VALUE_WEI,
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  defaultPolicy,
};
