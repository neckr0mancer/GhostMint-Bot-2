const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminCommandService } = require('../src/governance/adminCommandService');
const { AuthorizationError, createGovernanceService } = require('../src/governance/governanceService');
const { applyGovernance } = require('../src/transactions/policyRepository');

function nonOwnerFixture() {
  const repository = {
    isOwner: async () => false,
    findUserByPlatform: async () => 'target-user',
  };
  return createAdminCommandService(createGovernanceService(repository));
}

test('a non-owner cannot execute any admin input', async () => {
  const commands = [
    'group-set Standard 1 2 3 forced',
    'group-delete Standard',
    'assign telegram 123 Standard',
    'unassign telegram 123',
    'user-ceilings telegram 123 1 2 3',
    'user-ceilings-clear telegram 123',
    'user-simulation telegram 123 optional',
    'group-simulation Standard optional',
    'preset-set safe on 12 on',
    'owner telegram 123 on',
    'unknown-action',
    '',
  ];
  const admin = nonOwnerFixture();
  for (const command of commands) {
    await assert.rejects(admin.execute('regular-user', command), error => error instanceof AuthorizationError && error.code === 'OWNER_REQUIRED');
  }
});

const basePolicy = {
  simulationEnabled: false,
  gasCeilingGwei: 100,
  maxTransactionValueWei: 1000n,
  dailySpendingBudgetWei: 2000n,
  requiredConfirmations: 1,
  transactionTimeoutMs: 60_000,
};

test('regular-user ceilings always constrain the selected preset policy', () => {
  const effective = applyGovernance(basePolicy, {
    isOwner: false,
    maxTransactionValueWei: 100n,
    dailySpendingBudgetWei: 200n,
    gasCeilingGwei: 10,
    simulationForced: false,
    preset: { simulationMode: 'off', confirmationCount: 1, humanVerification: 'bypass' },
  });
  assert.equal(effective.maxTransactionValueWei, 100n);
  assert.equal(effective.dailySpendingBudgetWei, 200n);
  assert.equal(effective.gasCeilingGwei, 10);
});

test('forced simulation overrides presets and direct settings', () => {
  for (const preset of [null, { simulationMode: 'off', confirmationCount: 1, humanVerification: 'bypass' }]) {
    const effective = applyGovernance(basePolicy, {
      isOwner: false, maxTransactionValueWei: 1000n, dailySpendingBudgetWei: 2000n,
      gasCeilingGwei: 100, simulationForced: true, preset,
    }, 'blockchain');
    assert.equal(effective.simulationEnabled, true);
  }
});

test('owners are marked ceiling-exempt without disabling other safety settings', () => {
  const effective = applyGovernance(basePolicy, {
    isOwner: true, maxTransactionValueWei: 1n, dailySpendingBudgetWei: 1n,
    gasCeilingGwei: 1, simulationForced: true,
    preset: { simulationMode: 'off', confirmationCount: 3, humanVerification: 'on' },
  });
  assert.equal(effective.ceilingExempt, true);
  assert.equal(effective.simulationEnabled, true);
  assert.equal(effective.requiredConfirmations, 3);
});
