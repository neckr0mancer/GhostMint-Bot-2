const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const {
  createTestDatabasePool,
  integrationTest,
  runTestMigrations,
} = require('./helpers/disposableDatabase');

const EXPECTED = new Map([
  ['sniper_event_transitions_user_id_sniper_id_tx_hash_fkey', 'c'],
  ['sniper_seen_transactions_owner_fkey', 'c'],
  ['mint_task_attempts_user_id_task_id_fkey', 'c'],
  ['mint_task_preflight_checks_user_id_task_id_fkey', 'c'],
  ['mint_task_change_events_user_id_task_id_fkey', 'c'],
  ['live_acceptance_runs_wallet_fkey', 'r'],
  ['opensea_wallet_eligibility_wallet_owner_fk', 'c'],
]);

integrationTest('account merge ownership constraints match the verified catalog contract',
  { timeout: 120_000 }, async () => {
    await runTestMigrations({ migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
    const pool = await createTestDatabasePool({ max: 2 });
    try {
      const column = await pool.query(`SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='launch_squads' AND column_name='user_id'`);
      assert.equal(column.rows[0]?.data_type, 'uuid');
      assert.equal(column.rows[0]?.udt_name, 'uuid');

      const constraints = await pool.query(`SELECT conname, confupdtype, confdeltype
        FROM pg_constraint
        WHERE connamespace='public'::regnamespace
          AND conname = ANY($1::TEXT[])`, [[...EXPECTED.keys(), 'launch_squads_user_id_fkey']]);
      assert.equal(constraints.rowCount, EXPECTED.size + 1);
      for (const [name, deleteAction] of EXPECTED) {
        const constraint = constraints.rows.find(row => row.conname === name);
        assert.equal(constraint?.confupdtype, 'c', `${name} must cascade owner updates`);
        assert.equal(constraint?.confdeltype, deleteAction, `${name} must preserve delete behavior`);
      }
      const launchOwner = constraints.rows.find(row => row.conname === 'launch_squads_user_id_fkey');
      assert.equal(launchOwner?.confupdtype, 'c');
      assert.equal(launchOwner?.confdeltype, 'r');

      const ownerId = randomUUID();
      await pool.query('BEGIN');
      await pool.query('INSERT INTO users(user_id) VALUES ($1)', [ownerId]);
      await pool.query(`INSERT INTO launch_squads
        (id,user_id,name,chain,contract_address) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), ownerId, 'Merge ownership test', 'ethereum', '0x0000000000000000000000000000000000000001']);
      await assert.rejects(pool.query('DELETE FROM users WHERE user_id=$1', [ownerId]), error => {
        // PostgreSQL gives an explicit RESTRICT action its dedicated SQLSTATE instead of the
        // generic foreign-key violation code. Assert structured fields, not localized text.
        assert.equal(error.code, '23001');
        assert.equal(error.constraint, 'launch_squads_user_id_fkey');
        return true;
      });
      await pool.query('ROLLBACK');
    } finally {
      await pool.query('ROLLBACK').catch(() => {});
      await pool.end();
    }
  });
