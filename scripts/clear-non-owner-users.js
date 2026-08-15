// One-off, owner-operated maintenance tool to wipe every non-owner account -- for clearing out
// test/duplicate accounts accumulated during manual testing (e.g. repeated Discord test logins).
//
// This is INTENTIONALLY more destructive than scripts/merge-duplicate-account.js: it does not check
// whether an account is empty first. It deletes every non-owner account and everything attached to
// it -- including wallets and their encrypted private keys -- permanently and irreversibly. Owner
// accounts (is_owner=true) are never touched, no matter what.
//
// Requires the exact confirmation phrase below (not just RUN) specifically so this can't be
// triggered by copying another script's env vars out of habit, and prints a full report of exactly
// what was deleted, table by table, once it's done. Runs inside a single transaction: if anything
// goes wrong partway through, nothing is deleted.
//
// Manual, human-operated. Never run automatically in CI or a deployed environment.
const { CONFIG } = require('../src/config');
const { createDatabasePool } = require('../src/db/pool');
const { createRedactor } = require('../src/security/redaction');

const redact = createRedactor([
  CONFIG.databaseUrl,
  CONFIG.databaseUrlUnpooled,
  CONFIG.botToken,
  CONFIG.discordBotToken,
  ...Object.values(CONFIG.encryptionKeys),
]);

const REQUIRED_CONFIRMATION = 'DELETE-NON-OWNER-USERS';

// Deleted explicitly, in dependency order, before the users row itself: these either have no
// cascade or reference another table (wallet_id) that must go first. Everything else attached to a
// user (linked_accounts, account_link_codes, transaction_policies, user_governance, social_* /
// target_* / trigger_* tables, dashboard_sessions, group_retention_events, mint_task_attempts,
// sniper_seen_transactions, sniper_event_transitions) cascades automatically when the users row is
// deleted. bot_security_audit.user_id is set to NULL, not deleted, preserving the audit trail.
const EXPLICIT_DELETE_TABLES = ['transaction_intents', 'wallets', 'mint_tasks', 'activity', 'pnl_records', 'snipers'];

async function main() {
  if (process.env.CLEAR_CONFIRM !== REQUIRED_CONFIRMATION) {
    console.error(`Refusing to run: set CLEAR_CONFIRM=${REQUIRED_CONFIRMATION} to confirm you intend to `
      + 'permanently delete every non-owner account and all of its data, including wallet private keys.');
    process.exitCode = 1;
    return;
  }

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const targets = await client.query('SELECT user_id FROM users WHERE is_owner=FALSE FOR UPDATE');
    const userIds = targets.rows.map(row => row.user_id);
    if (!userIds.length) {
      await client.query('COMMIT');
      console.log('No non-owner accounts found; nothing to delete.');
      return;
    }

    const counts = {};
    for (const table of EXPLICIT_DELETE_TABLES) {
      const result = await client.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [userIds]);
      counts[table] = result.rowCount;
    }
    const deletedUsers = await client.query('DELETE FROM users WHERE user_id = ANY($1) AND is_owner=FALSE RETURNING user_id', [userIds]);

    await client.query('COMMIT');
    console.log(redact([
      `Deleted ${deletedUsers.rowCount} non-owner account(s) and everything attached to them:`,
      ...EXPLICIT_DELETE_TABLES.map(table => `  ${table}: ${counts[table]}`),
      '(linked_accounts, tasks/snipers/watch-rules config, dashboard sessions, and other per-user rows were removed automatically via cascade.)',
    ].join('\n')));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(redact(`Clear failed, no changes made: ${error.message}`));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
