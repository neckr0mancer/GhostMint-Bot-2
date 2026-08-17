const assert = require('node:assert/strict');
const test = require('node:test');
const { createPostgresGovernanceRepository } = require('../src/governance/postgresGovernanceRepository');

// Unit-level coverage for listGovernedUsers' row -> object mapping, specifically the
// account-lifecycle fields (status_reason/suspended_until/status_changed_at) that the
// Admin dashboard's UserDetail/UserActions components now read (user.statusReason,
// user.suspendedUntil). This does not require a database: it stubs pool.query directly,
// so it proves the SQL-to-camelCase mapping without needing network/DB access.
function fakePool(rows) {
  return { query: async () => ({ rows, rowCount: rows.length }) };
}

test('listGovernedUsers maps status_reason/suspended_until/status_changed_at to camelCase fields', async () => {
  const suspendedUntil = new Date('2026-09-01T00:00:00Z');
  const statusChangedAt = new Date('2026-08-14T12:00:00Z');
  const lastActiveAt = new Date('2026-08-16T09:00:00Z');
  const rows = [{
    user_id: 'user-1', is_owner: false, account_status: 'suspended',
    status_reason: 'Repeated failed mint attempts', suspended_until: suspendedUntil,
    status_changed_at: statusChangedAt, subscription_active: true, good_standing_override: false,
    group_name: 'standard', max_transaction_value_wei: '1000000000000000000',
    daily_spending_budget_wei: '5000000000000000000', gas_ceiling_gwei: '50',
    simulation_forced: true, selected_preset_key: 'safe', scheduled_removal_at: null,
    last_active_at: lastActiveAt,
    linked_accounts: [{ platform: 'telegram', platformUserId: '123' }],
  }];
  const repository = createPostgresGovernanceRepository(fakePool(rows));
  const [user] = await repository.listGovernedUsers();

  assert.equal(user.userId, 'user-1');
  assert.equal(user.accountStatus, 'suspended');
  assert.equal(user.statusReason, 'Repeated failed mint attempts');
  assert.equal(user.suspendedUntil, suspendedUntil);
  assert.equal(user.statusChangedAt, statusChangedAt);
  // gas_ceiling_gwei is coerced to a Number for consistency with the rest of the repository.
  assert.equal(user.gasCeilingGwei, 50);
  assert.equal(user.lastActiveAt, lastActiveAt);
  assert.deepEqual(user.linkedAccounts, [{ platform: 'telegram', platformUserId: '123' }]);
});

test('listGovernedUsers leaves status fields null for an active user with no lifecycle history', async () => {
  const rows = [{
    user_id: 'user-2', is_owner: false, account_status: 'active',
    status_reason: null, suspended_until: null, status_changed_at: null,
    subscription_active: false, good_standing_override: false, group_name: null,
    max_transaction_value_wei: null, daily_spending_budget_wei: null, gas_ceiling_gwei: null,
    simulation_forced: null, selected_preset_key: null, scheduled_removal_at: null,
    last_active_at: null,
    linked_accounts: [],
  }];
  const repository = createPostgresGovernanceRepository(fakePool(rows));
  const [user] = await repository.listGovernedUsers();

  assert.equal(user.accountStatus, 'active');
  assert.equal(user.statusReason, null);
  assert.equal(user.suspendedUntil, null);
  assert.equal(user.statusChangedAt, null);
  assert.equal(user.gasCeilingGwei, null);
  assert.equal(user.lastActiveAt, null);
});

// Regression test: mapPreset used to check `if (!row) return null`, but `row` is the entire
// joined getEffectiveGovernance result (always truthy), not the mode_presets columns. For a user
// with no selected_preset_key, the LEFT JOIN leaves every mp.* column null, and the old check let
// mapPreset build a fake preset object with confirmationCount: Number(null) === 0 -- which
// applyGovernance then wrote straight into transaction_intents.required_confirmations, violating
// its BETWEEN 1 AND 1000 check constraint on every execution for a user who never selected a
// preset via /mode.
test('getEffectiveGovernance returns a null preset (not a zeroed fake one) for a user with no selected preset', async () => {
  const rows = [{
    is_owner: true, user_max: null, user_daily: null, user_gas: null, user_simulation_forced: null,
    group_max: null, group_daily: null, group_gas: null, group_simulation_forced: null,
    preset_key: null, display_name: null, simulation_mode: null, confirmation_count: null, human_verification: null,
  }];
  const repository = createPostgresGovernanceRepository(fakePool(rows));
  const governance = await repository.getEffectiveGovernance('user-3', 'ethereum');

  assert.equal(governance.preset, null);
});
