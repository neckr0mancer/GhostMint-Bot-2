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
    dashboard_active: true, active_any_platform_24h: true,
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
  assert.equal(user.dashboardActive, true);
  assert.equal(user.activeAnyPlatform24h, true);
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
    dashboard_active: false, active_any_platform_24h: false,
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
  assert.equal(user.dashboardActive, false);
  assert.equal(user.activeAnyPlatform24h, false);
  assert.equal(user.lastActiveAt, null);
});

test('listGovernedUsers computes activity flags with the same windows as the admin overview', async () => {
  let capturedSql = '';
  const rows = [{
    user_id: 'user-activity', is_owner: false, is_root_owner: false, account_status: 'active',
    status_reason: null, suspended_until: null, status_changed_at: null,
    subscription_active: false, good_standing_override: false, group_name: null,
    max_transaction_value_wei: null, daily_spending_budget_wei: null, gas_ceiling_gwei: null,
    simulation_forced: null, selected_preset_key: null, scheduled_removal_at: null,
    dashboard_active: false, active_any_platform_24h: true, last_active_at: null, linked_accounts: [],
  }];
  const pool = { query: async sql => {
    capturedSql = sql;
    return { rows, rowCount: rows.length };
  } };
  const repository = createPostgresGovernanceRepository(pool);
  const [user] = await repository.listGovernedUsers();

  assert.match(capturedSql, /revoked_at IS NULL AND ds\.expires_at>NOW\(\)/);
  assert.match(capturedSql, /last_seen_at>=NOW\(\)-INTERVAL '15 minutes'/);
  assert.match(capturedSql, /occurred_at>=NOW\(\)-INTERVAL '24 hours'/);
  assert.equal(user.dashboardActive, false);
  assert.equal(user.activeAnyPlatform24h, true);
});

test('listGroups exposes the configured retention policy with camelCase field names', async () => {
  let capturedSql = '';
  const rows = [{
    name: 'Collectors', max_transaction_value_wei: '1000', daily_spending_budget_wei: '5000',
    gas_ceiling_gwei: '42.5', simulation_forced: true, advanced_modes_allowed: false,
    retention_period_days: 30, require_active_subscription: true, require_recent_activity_days: 14,
    updated_at: new Date('2026-10-18T10:00:00Z'),
  }];
  const pool = { query: async sql => {
    capturedSql = sql;
    return { rows, rowCount: rows.length };
  } };
  const repository = createPostgresGovernanceRepository(pool);
  const [group] = await repository.listGroups();

  assert.match(capturedSql, /retention_period_days/);
  assert.match(capturedSql, /require_active_subscription/);
  assert.match(capturedSql, /require_recent_activity_days/);
  assert.equal(group.retentionPeriodDays, 30);
  assert.equal(group.requireActiveSubscription, true);
  assert.equal(group.requireRecentActivityDays, 14);
});

test('listGroups preserves disabled retention checks as false and null', async () => {
  const rows = [{
    name: 'Standard', max_transaction_value_wei: '1000', daily_spending_budget_wei: '5000',
    gas_ceiling_gwei: '20', simulation_forced: false, advanced_modes_allowed: false,
    retention_period_days: null, require_active_subscription: false, require_recent_activity_days: null,
    updated_at: null,
  }];
  const repository = createPostgresGovernanceRepository(fakePool(rows));
  const [group] = await repository.listGroups();

  assert.equal(group.retentionPeriodDays, null);
  assert.equal(group.requireActiveSubscription, false);
  assert.equal(group.requireRecentActivityDays, null);
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

test('getEffectiveGovernance downgrades and clears a revoked advanced preset without erasing a concurrent choice', async () => {
  const calls = [];
  const effectiveRow = {
    is_owner: false, user_max: null, user_daily: null, user_gas: null,
    user_simulation_forced: null, user_advanced: false, group_advanced: false,
    group_max: null, group_daily: null, group_gas: null, group_simulation_forced: null,
    requested_preset_key: 'ultra_fast', preset_key: 'safe', display_name: 'Normie',
    simulation_mode: 'on', confirmation_count: 128, human_verification: 'on',
    gas_price_multiplier: '1', is_default: true,
  };
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/^UPDATE user_governance/.test(sql.trim())) return { rows: [], rowCount: 1 };
    return { rows: [effectiveRow], rowCount: 1 };
  } };
  const repository = createPostgresGovernanceRepository(pool);
  const governance = await repository.getEffectiveGovernance('user-revoked', 'ethereum');

  assert.equal(governance.advancedModesAllowed, false);
  assert.equal(governance.preset.key, 'safe');
  assert.equal(governance.preset.displayName, 'Normie');
  assert.match(calls[0].sql, /CASE WHEN ug\.selected_preset_key IN \('ultra_fast','fast'\)/);
  assert.match(calls[0].sql, /ug\.selected_preset_key AS requested_preset_key/);
  assert.match(calls[1].sql, /WHERE user_id=\$1 AND selected_preset_key=\$2/);
  assert.deepEqual(calls[1].params, ['user-revoked', 'ultra_fast']);
});

test('an explicit per-user advanced-mode denial overrides a group grant', async () => {
  const calls = [];
  const effectiveRow = {
    is_owner: false, user_max: null, user_daily: null, user_gas: null,
    user_simulation_forced: null, user_advanced: false, group_advanced: true,
    group_max: null, group_daily: null, group_gas: null, group_simulation_forced: null,
    requested_preset_key: 'fast', preset_key: 'safe', display_name: 'Normie',
    simulation_mode: 'on', confirmation_count: 128, human_verification: 'on',
    gas_price_multiplier: '1', is_default: true,
  };
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/^UPDATE user_governance/.test(sql.trim())) return { rows: [], rowCount: 1 };
    return { rows: [effectiveRow], rowCount: 1 };
  } };
  const repository = createPostgresGovernanceRepository(pool);
  const governance = await repository.getEffectiveGovernance('user-denied', 'ethereum');

  assert.equal(governance.advancedModesAllowed, false);
  assert.equal(governance.preset.key, 'safe');
  assert.deepEqual(calls[1].params, ['user-denied', 'fast']);
});
