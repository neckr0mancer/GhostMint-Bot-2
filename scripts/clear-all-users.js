// EXTREMELY DESTRUCTIVE, owner-operated maintenance tool: wipes every account in the database,
// including owners -- unlike scripts/clear-non-owner-users.js, which explicitly protects owner
// accounts, this one does not. Deletes every user and everything attached to them, permanently and
// irreversibly: wallets (and their encrypted private keys), linked Telegram/Discord identities,
// scheduled tasks, activity history, snipers, P&L records, dashboard sessions, governance settings
// -- everything. After this runs there are zero users in the database; every owner (including root
// owners) must re-link from scratch via /link.
//
// Uses TRUNCATE ... CASCADE rather than deleting from a hand-enumerated list of tables in
// dependency order -- that approach broke in practice (a table added in a later migration,
// live_acceptance_runs, has ON DELETE RESTRICT straight to users and wasn't in the list). TRUNCATE
// CASCADE asks Postgres to find and clear every table with a foreign key pointing, directly or
// transitively, at users -- it overrides each table's own ON DELETE behavior (CASCADE, RESTRICT, or
// SET NULL all yield to it), so there's no dependency order to get wrong and no table that can be
// missed just because it was added later.
//
// Requires the exact confirmation phrase below, via a DIFFERENT env var than
// clear-non-owner-users.js uses, specifically so the two scripts can never be triggered by copying
// the wrong one's env vars out of habit. Runs inside a single transaction: if anything goes wrong,
// nothing is deleted (TRUNCATE is transactional in Postgres, unlike most other databases).
//
// Manual, human-operated only. Never run automatically in CI or a deployed environment. Before
// running this against a database with real wallets, make sure any private key you care about has
// already been exported/backed up elsewhere -- this is the only place those encrypted keys are
// stored, and once deleted they cannot be recovered.
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

const REQUIRED_CONFIRMATION = 'DELETE-ALL-USERS-INCLUDING-OWNERS';

async function main() {
  if (process.env.CLEAR_ALL_CONFIRM !== REQUIRED_CONFIRMATION) {
    console.error(`Refusing to run: set CLEAR_ALL_CONFIRM=${REQUIRED_CONFIRMATION} to confirm you intend to `
      + 'permanently delete every account in this database, including owners, and all of its data, '
      + 'including wallet private keys.');
    process.exitCode = 1;
    return;
  }

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const before = await client.query('SELECT count(*)::int AS count FROM users');
    if (!before.rows[0].count) {
      await client.query('COMMIT');
      console.log('No accounts found; nothing to delete.');
      return;
    }

    await client.query('TRUNCATE TABLE users CASCADE');

    await client.query('COMMIT');
    console.log(`Deleted ${before.rows[0].count} account(s) (including any owners) and everything attached to `
      + 'them via cascade -- wallets and their encrypted keys, linked Telegram/Discord identities, scheduled '
      + 'tasks, activity history, snipers, presets, dashboard sessions, and all other per-user data. The '
      + 'database now has zero users. Every account, including owners, must re-link via /link to use the bot again.');
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
