const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createGovernanceService } = require('../src/governance/governanceService');
const { createPostgresGovernanceRepository } = require('../src/governance/postgresGovernanceRepository');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createTransactionPolicyRepository } = require('../src/transactions/policyRepository');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('group, individual, simulation, owner, and editable-preset precedence persists', { timeout: 60_000 }, async () => {
  const migration = await runMigrations({ connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
  assert.equal(migration.connection, 'unpooled');
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const repository = createPostgresGovernanceRepository(pool);
  const governance = createGovernanceService(repository);
  const policies = createTransactionPolicyRepository(pool, { governanceRepository: repository });
  const suffix = `${process.pid}-${Date.now()}`;
  let ownerId;
  let userId;
  const preexistingOwnerCount = Number((await pool.query('SELECT COUNT(*) AS count FROM users WHERE is_owner=TRUE')).rows[0].count);
  const groupName = `Standard-${suffix}`;
  try {
    ownerId = await identity.resolveOrCreate('telegram', `owner-${suffix}`);
    userId = await identity.resolveOrCreate('telegram', `user-${suffix}`);
    await pool.query('UPDATE users SET is_owner=TRUE,is_root_owner=TRUE WHERE user_id=$1', [ownerId]);
    await governance.upsertGroup(ownerId, { name: groupName, maxTransactionValueWei: 100n,
      dailySpendingBudgetWei: 200n, gasCeilingGwei: 10, simulationForced: 'optional', advancedModesAllowed: 'allowed' });
    await governance.upsertGroup(ownerId, { name: groupName.toLowerCase(), maxTransactionValueWei: 100n,
      dailySpendingBudgetWei: 200n, gasCeilingGwei: 10, simulationForced: 'optional', advancedModesAllowed: 'allowed' });
    await governance.assignGroup(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, groupName });
    await policies.setPolicy({ userId, scopeType: 'wallet', scopeId: '1', settings: {
      simulationEnabled: false, maxTransactionValueWei: 1000n,
      dailySpendingBudgetWei: 2000n, gasCeilingGwei: 100,
    } });
    await governance.selectPreset(userId, 'ultra_fast');

    let effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum' });
    assert.equal(effective.maxTransactionValueWei, 100n);
    assert.equal(effective.dailySpendingBudgetWei, 200n);
    assert.equal(effective.gasCeilingGwei, 10);

    await governance.setUserCeilings(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`,
      maxTransactionValueWei: 50n, dailySpendingBudgetWei: 150n, gasCeilingGwei: 5 });
    effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum' });
    assert.equal(effective.maxTransactionValueWei, 50n);
    assert.equal(effective.dailySpendingBudgetWei, 150n);
    assert.equal(effective.gasCeilingGwei, 5);

    await governance.setUserSimulation(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, simulationForced: 'forced' });
    effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum', triggerSource: 'blockchain' });
    assert.equal(effective.simulationEnabled, true);

    await governance.setUserSimulation(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, simulationForced: 'inherit' });
    await governance.setGroupSimulation(ownerId, { groupName, simulationForced: 'inherit' });
    effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum', triggerSource: 'blockchain' });
    assert.equal(effective.simulationEnabled, true, 'cleared user and group rules fall back to forced-on');

    await governance.setUserSimulation(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, simulationForced: 'optional' });
    await governance.selectPreset(userId, 'semi_safe');
    effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum' });
    assert.equal(effective.simulationEnabled, true);
    assert.equal(effective.requiredConfirmations, 12);
    await governance.updatePreset(ownerId, { presetKey: 'semi_safe', simulationMode: 'off', confirmationCount: 2, humanVerification: 'bypass' });
    effective = await policies.resolvePolicy({ userId, walletId: 1, chain: 'ethereum' });
    assert.equal(effective.simulationEnabled, false);
    assert.equal(effective.requiredConfirmations, 2);
    assert.equal(effective.humanVerification, 'bypass');

    const ownerPolicy = await policies.resolvePolicy({ userId: ownerId, walletId: 999, chain: 'ethereum' });
    assert.equal(ownerPolicy.ceilingExempt, true);
    await governance.setOwner(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, enabled: 'on' });
    assert.equal(await repository.isOwner(userId), true);
    await governance.setOwner(ownerId, { platform: 'telegram', platformUserId: `user-${suffix}`, enabled: 'off' });
    // ownerId only needed root status for the setOwner calls above; a root owner must be demoted
    // from root before its regular owner status can be touched at all (root removing its own root
    // status here exercises the "last root owner" invariant), then the plain "last owner" invariant
    // is exercised directly at the repository layer, same as governance.setOwner's own target check.
    const demoteFromRoot=governance.setRootOwner(ownerId, { platform: 'telegram', platformUserId: `owner-${suffix}`, enabled: 'off' });
    if(preexistingOwnerCount===0){
      await assert.rejects(demoteFromRoot,/last root owner/);
    } else {
      await demoteFromRoot;
      await repository.setOwner(ownerId,false);
      assert.equal(await repository.isOwner(ownerId),false);
    }
  } finally {
    await pool.query(`UPDATE mode_presets SET simulation_mode='on',confirmation_count=12,
      human_verification='on',updated_by=NULL WHERE preset_key='semi_safe'`).catch(() => {});
    await pool.query('DELETE FROM seat_groups WHERE LOWER(name)=LOWER($1)', [groupName]).catch(() => {});
    if (userId) await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    if (ownerId) await pool.query('DELETE FROM users WHERE user_id=$1', [ownerId]).catch(() => {});
    await pool.end();
  }
});
