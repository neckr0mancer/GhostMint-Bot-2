const assert = require('node:assert/strict');
const test = require('node:test');
const { createPostgresGovernanceRepository } = require('../src/governance/postgresGovernanceRepository');

// Unit-level coverage for listGovernedUsers' row -> object mapping, specifically the
// account-lifecycle fields (status_reason/suspended_until/status_changed_at) that the
// Admin dashboard's UserDetail/UserActions components now read (user.statusReason,
// user.suspendedUntil). This does not require a database: it stubs pool.query directly,
// so it proves the SQL-to-camelCase mapping without needing network/DB access.
function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

test('listGovernedUsers maps status_reason/suspended_until/status_changed_at to camelCase fields', async () => {
  const suspendedUntil = new Date('2026-09-01T00:00:00Z');
  const statusChangedAt = new Date('2026-08-14T12:00:00Z');
  const rows = [{
    user_id: 'user-1', is_owner: false, account_status: 'suspended',
    status_reason: 'Repeated failed mint attempts', suspended_until: suspendedUntil,
    status_changed_at: statusChangedAt, subscription_active: true, good_standing_override: false,
    group_name: 'standard', max_transaction_value_wei: '1000000000000000000',
    daily_spending_budget_wei: '5000000000000000000', gas_ceiling_gwei: '50',
    simulation_forced: true, selected_preset_key: 'safe', scheduled_removal_at: null,
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
  assert.deepEqual(user.linkedAccounts, [{ platform: 'telegram', platformUserId: '123' }]);
});

test('listGovernedUsers leaves status fields null for an active user with no lifecycle history', async () => {
  const rows = [{
    user_id: 'user-2', is_owner: false, account_status: 'active',
    status_reason: null, suspended_until: null, status_changed_at: null,
    subscription_active: false, good_standing_override: false, group_name: null,
    max_transaction_value_wei: null, daily_spending_budget_wei: null, gas_ceiling_gwei: null,
    simulation_forced: null, selected_preset_key: null, scheduled_removal_at: null,
    linked_accounts: [],
  }];
  const repository = createPostgresGovernanceRepository(fakePool(rows));
  const [user] = await repository.listGovernedUsers();

  assert.equal(user.accountStatus, 'active');
  assert.equal(user.statusReason, null);
  assert.equal(user.suspendedUntil, null);
  assert.equal(user.statusChangedAt, null);
  assert.equal(user.gasCeilingGwei, null);
});
