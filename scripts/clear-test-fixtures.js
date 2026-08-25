// DISABLED (BASE-005, Model 2 phase-2): this script matched ALL addresses under 0x…00% (256
// possibilities), not only the documented …22/33/44. A user with one such task and no other
// evidence could have their legitimate wallets and keys deleted. The 1,714-task / 33-wallet
// purge cannot be verified as safe retroactively. Do not re-enable until the script uses
// explicit fixture tenant/run IDs, requires a production-guard flag, and has a disposable-
// PostgreSQL regression proving it deletes only tagged rows. Wallet/key deletion has been
// permanently removed — wallet ownership must never be inferred from task history.
console.error(
  'DISABLED (BASE-005): this script matched all 0x…00% addresses, not only documented fixtures.\n' +
  'It cannot verify that deleted wallets/keys were disposable. Do not use until redesigned\n' +
  'with explicit fixture tenant IDs and a disposable-PostgreSQL safety regression.'
);
process.exit(1);
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

    const intents = await client.query(
      `SELECT intent_id, user_id FROM transaction_intents WHERE to_address LIKE $1`, [LIKE]);
    console.log(`fixture transaction_intents: ${intents.rowCount}`);

    if (!yes) {
      console.log('\nDRY RUN — nothing deleted. Re-run with --yes to delete.');
      return;
    }

    await client.query('BEGIN');
    if (tasks.rowCount) await client.query(`DELETE FROM mint_tasks WHERE contract_address LIKE $1`, [LIKE]);
    if (intents.rowCount) await client.query(`DELETE FROM transaction_intents WHERE to_address LIKE $1`, [LIKE]);
    await client.query('COMMIT');
    console.log(`\nDeleted: ${tasks.rowCount} tasks, ${intents.rowCount} intents. Wallets and users are NEVER deleted by this script.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error.message); process.exit(1); });
