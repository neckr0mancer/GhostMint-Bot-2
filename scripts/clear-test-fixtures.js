// Removes integration-test fixture rows from the shared database so log/DB triage stops wading
// through them (Round 21 follow-up: "the dev DB doubles as the integration-test target; a cleanup
// script for fixture rows would make future triage much faster").
//
// The fixture signature is precise: every test harness mints against one of the canonical fake
// contracts 0x0000000000000000000000000000000000000022 / -33 / -44 (38+ leading zeros). Real
// contracts never look like that, so contract_address LIKE '0x00000000000000000000000000000000000000%'
// is the marker -- the same filter the failed-task triage queries already apply by hand.
//
// Dry-run by default. Pass --yes to actually delete. Never prints secrets; deletes only:
//   1. mint_tasks whose contract matches the fixture pattern
//   2. transaction_intents whose to_address matches it
//   3. wallets on users whose every task matched (fixture users own nothing real)
//   4. users left with no wallets, tasks, activity, pnl, or intents at all
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createDatabasePool } = require('../src/db/pool');

async function main() {
  const yes = process.argv.includes('--yes');
  const pool = createDatabasePool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const LIKE = '0x00000000000000000000000000000000000000%';
  try {
    const tasks = await client.query(
      `SELECT id, user_id, name FROM mint_tasks WHERE contract_address LIKE $1`, [LIKE]);
    console.log(`fixture mint_tasks: ${tasks.rowCount}`);
    tasks.rows.slice(0, 10).forEach(row => console.log(`  ${row.id} "${row.name}" user ${row.user_id.slice(0, 8)}…`));

    const intents = await client.query(
      `SELECT intent_id, user_id FROM transaction_intents WHERE to_address LIKE $1`, [LIKE]);
    console.log(`fixture transaction_intents: ${intents.rowCount}`);

    const userIds = [...new Set([...tasks.rows.map(r => r.user_id), ...intents.rows.map(r => r.user_id)])];
    let wallets = { rowCount: 0, rows: [] };
    let staleUsers = { rowCount: 0, rows: [] };
    if (userIds.length) {
      wallets = await client.query(
        `SELECT w.id, w.user_id, w.label FROM wallets w
         WHERE w.user_id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM mint_tasks t WHERE t.user_id = w.user_id AND t.contract_address NOT LIKE $2)
           AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = w.user_id)
         ORDER BY w.user_id`, [userIds, LIKE]);
      console.log(`fixture-only wallets: ${wallets.rowCount}`);
      const remaining = await client.query(
        `SELECT u.user_id FROM users u
         WHERE u.user_id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.user_id)
           AND NOT EXISTS (SELECT 1 FROM mint_tasks t WHERE t.user_id = u.user_id AND t.contract_address NOT LIKE $2)
           AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = u.user_id)
           AND NOT EXISTS (SELECT 1 FROM pnl_records p WHERE p.user_id = u.user_id)
           AND NOT EXISTS (SELECT 1 FROM transaction_intents i WHERE i.user_id = u.user_id AND i.to_address NOT LIKE $2)`,
        [userIds, LIKE]);
      staleUsers = remaining;
      console.log(`users left with nothing real: ${remaining.rowCount}`);
    }

    if (!yes) {
      console.log('\nDRY RUN — nothing deleted. Re-run with --yes to delete.');
      return;
    }

    await client.query('BEGIN');
    if (tasks.rowCount) await client.query(`DELETE FROM mint_tasks WHERE contract_address LIKE $1`, [LIKE]);
    if (intents.rowCount) await client.query(`DELETE FROM transaction_intents WHERE to_address LIKE $1`, [LIKE]);
    if (wallets.rowCount) await client.query(
      `DELETE FROM wallets w USING (SELECT unnest($1::uuid[]) uid, unnest($2::text[]) lbl) d(user_id, label)
       WHERE w.user_id = d.uid AND w.label = d.lbl`,
      [wallets.rows.map(r => r.user_id), wallets.rows.map(r => r.label)]);
    if (staleUsers.rowCount) await client.query(
      `DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [staleUsers.rows.map(r => r.user_id)]);
    await client.query('COMMIT');
    console.log(`\nDeleted: ${tasks.rowCount} tasks, ${intents.rowCount} intents, ${wallets.rowCount} wallets, ${staleUsers.rowCount} users.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error.message); process.exit(1); });
