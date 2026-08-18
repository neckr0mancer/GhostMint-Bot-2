const assert = require('node:assert/strict');
const test = require('node:test');
const { formatAdminOverview } = require('../src/governance/adminOverviewFormat');

// Section O -- menu:admin on both platforms renders through this shared formatter so Telegram and
// Discord can't independently drift on how governance.dashboardOverview's wei figures are shown.

test('converts each group\'s wei ceilings to plain ETH strings, leaving metrics untouched', () => {
  const result = formatAdminOverview({
    metrics: { totalUsers: 5, activeAnyPlatform24h: 2, owners: 1, rootOwners: 1, groups: 1, linkedAccounts: 3 },
    groups: [{ name: 'Standard', gasCeilingGwei: 50, maxTransactionValueWei: '500000000000000000', dailySpendingBudgetWei: '2000000000000000000' }],
  });
  assert.deepEqual(result.metrics, { totalUsers: 5, activeAnyPlatform24h: 2, owners: 1, rootOwners: 1, groups: 1, linkedAccounts: 3 });
  assert.deepEqual(result.groups, [{ name: 'Standard', gasCeilingGwei: 50, maxTransactionValueEth: '0.5', dailySpendingBudgetEth: '2.0' }]);
});

test('a null wei ceiling stays null -- "no ceiling" is distinct from "0"', () => {
  const result = formatAdminOverview({
    metrics: { totalUsers: 1, activeAnyPlatform24h: 0, owners: 1, rootOwners: 0, groups: 1, linkedAccounts: 0 },
    groups: [{ name: 'Unlimited', gasCeilingGwei: null, maxTransactionValueWei: null, dailySpendingBudgetWei: null }],
  });
  assert.deepEqual(result.groups, [{ name: 'Unlimited', gasCeilingGwei: null, maxTransactionValueEth: null, dailySpendingBudgetEth: null }]);
});

test('an empty groups list stays an empty list', () => {
  const result = formatAdminOverview({ metrics: { totalUsers: 0, activeAnyPlatform24h: 0, owners: 0, rootOwners: 0, groups: 0, linkedAccounts: 0 }, groups: [] });
  assert.deepEqual(result.groups, []);
});
