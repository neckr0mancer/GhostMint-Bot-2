const { formatEther } = require('ethers');

// Shared by both platforms' menu:admin button (Section O) so Telegram and Discord can't silently
// render governance.dashboardOverview's wei figures differently -- same reasoning as
// mintFlowDecision.js/watchRuleFlowDecision.js existing to keep cross-platform behavior in one
// place. Pure: takes the {groups, metrics} shape dashboardOverview already returns and converts
// each group's wei ceilings to plain ETH strings (null stays null -- "no ceiling" is a real,
// distinct state from "0", and each menu renderer already knows how to word that).
function formatAdminOverview({ metrics, groups }) {
  return {
    metrics,
    groups: groups.map(group => ({
      name: group.name,
      gasCeilingGwei: group.gasCeilingGwei,
      maxTransactionValueEth: group.maxTransactionValueWei === null ? null : formatEther(BigInt(group.maxTransactionValueWei)),
      dailySpendingBudgetEth: group.dailySpendingBudgetWei === null ? null : formatEther(BigInt(group.dailySpendingBudgetWei)),
    })),
  };
}

module.exports = { formatAdminOverview };
