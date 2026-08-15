// One-off, owner-operated maintenance tool for a specific account-linking edge case:
//
// Both Telegram and Discord auto-create a fresh GhostMint account the first time a
// platform identity is seen (identityService.resolveOrCreate), even without ever using
// a link code. If someone messages the bot on Discord before linking it to an existing
// Telegram account, Discord ends up with its own separate account -- and the Telegram
// link code then correctly refuses to attach to it, because it's already tied to a
// different account (see LinkCodeError('This platform account is already linked to
// another user') in src/identity/identityService.js).
//
// This script resolves that specific case by repointing the source platform identity's
// linked_accounts row onto the target account and removing the now-orphaned source
// account -- but ONLY if the source account is verified empty first (no wallets, tasks,
// activity, or other data). If it is not empty, this refuses and changes nothing; that
// case needs a real data merge, which this tool deliberately does not attempt.
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

// Tables holding real user data, keyed by user_id, that must be empty for the source
// account before it's safe to delete. (linked_accounts and account_link_codes are
// expected/handled separately; everything else here means the account was actually used.)
const DATA_TABLES = [
  ['wallets', 'user_id'],
  ['mint_tasks', 'user_id'],
  ['activity', 'user_id'],
  ['pnl_records', 'user_id'],
  ['snipers', 'user_id'],
  ['transaction_policies', 'user_id'],
  ['transaction_intents', 'user_id'],
  ['social_watch_rules', 'user_id'],
  ['social_trigger_events', 'user_id'],
  ['social_adapter_usage', 'user_id'],
  ['target_trigger_policies', 'user_id'],
  ['target_bypass_challenges', 'user_id'],
  ['trigger_execution_requests', 'user_id'],
  ['trigger_execution_audit', 'user_id'],
  ['dashboard_sessions', 'user_id'],
  ['group_retention_events', 'user_id'],
  ['seat_groups', 'created_by'],
  ['mode_presets', 'updated_by'],
  ['user_governance', 'updated_by'],
  ['users', 'status_changed_by'],
];

function readInput() {
  return {
    sourcePlatform: process.env.MERGE_SOURCE_PLATFORM,
    sourcePlatformUserId: process.env.MERGE_SOURCE_PLATFORM_USER_ID,
    targetPlatform: process.env.MERGE_TARGET_PLATFORM,
    targetPlatformUserId: process.env.MERGE_TARGET_PLATFORM_USER_ID,
  };
}

async function findEmptinessViolations(client, userId) {
  const violations = [];

  const governance = await client.query(
    `SELECT group_id,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,
      simulation_forced,selected_preset_key,scheduled_removal_at
     FROM user_governance WHERE user_id=$1`, [userId]);
  if (governance.rowCount) {
    const row = governance.rows[0];
    const customized = Object.entries(row).some(([key, value]) => key !== 'user_id' && value !== null);
    if (customized) violations.push('user_governance has non-default ceilings/group/preset settings');
  }

  const user = await client.query(
    `SELECT is_owner,account_status,status_reason,suspended_until,subscription_active,
      good_standing_override,dashboard_theme,default_chain
     FROM users WHERE user_id=$1`, [userId]);
  if (!user.rowCount) violations.push('source account no longer exists');
  else {
    const row = user.rows[0];
    if (row.is_owner) violations.push('source account is a governance owner -- refusing to touch it');
    if (row.account_status !== 'active' || row.status_reason || row.suspended_until) {
      violations.push(`source account has a non-default account_status (${row.account_status})`);
    }
    if (row.subscription_active) violations.push('source account has subscription_active=true');
    if (row.good_standing_override) violations.push('source account has good_standing_override=true');
    if (row.dashboard_theme && row.dashboard_theme !== 'ghost-mint') violations.push('source account changed its dashboard theme');
    if (row.default_chain) violations.push('source account has a default_chain set');
  }

  const linked = await client.query('SELECT platform,platform_user_id FROM linked_accounts WHERE user_id=$1', [userId]);
  if (linked.rowCount > 1) {
    violations.push(`source account has ${linked.rowCount} linked platform identities, not just the one being merged`);
  }

  for (const [table, column] of DATA_TABLES) {
    const result = await client.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE ${column}=$1`, [userId]);
    if (result.rows[0].count > 0) violations.push(`${table}.${column} has ${result.rows[0].count} row(s)`);
  }

  return violations;
}

async function main() {
  if (process.env.MERGE_CONFIRM !== 'RUN') {
    console.error('Refusing to run: set MERGE_CONFIRM=RUN to confirm you intend to repoint and '
      + 'delete a duplicate account. This only proceeds if the source account is verified empty.');
    process.exitCode = 1;
    return;
  }

  const input = readInput();
  for (const [key, value] of Object.entries(input)) {
    if (!value) {
      console.error(`Refusing to run: ${key} is required (see script header for the full list of MERGE_* env vars).`);
      process.exitCode = 1;
      return;
    }
  }
  if (!['telegram', 'discord'].includes(input.sourcePlatform) || !['telegram', 'discord'].includes(input.targetPlatform)) {
    console.error('Refusing to run: MERGE_SOURCE_PLATFORM and MERGE_TARGET_PLATFORM must each be telegram or discord.');
    process.exitCode = 1;
    return;
  }

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const source = await client.query(
      'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
      [input.sourcePlatform, input.sourcePlatformUserId]);
    if (!source.rowCount) {
      throw new Error(`No linked account found for ${input.sourcePlatform}:${input.sourcePlatformUserId}`);
    }
    const target = await client.query(
      'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
      [input.targetPlatform, input.targetPlatformUserId]);
    if (!target.rowCount) {
      throw new Error(`No linked account found for ${input.targetPlatform}:${input.targetPlatformUserId}`);
    }

    const sourceUserId = source.rows[0].user_id;
    const targetUserId = target.rows[0].user_id;
    if (sourceUserId === targetUserId) {
      throw new Error('Source and target platform identities already belong to the same account -- nothing to merge.');
    }

    const violations = await findEmptinessViolations(client, sourceUserId);
    if (violations.length) {
      throw new Error('Refusing to merge -- the source account is not empty:\n  - ' + violations.join('\n  - ')
        + '\nThis tool only handles an empty duplicate account. A non-empty duplicate needs a real data merge.');
    }

    await client.query(
      'UPDATE linked_accounts SET user_id=$2 WHERE platform=$3 AND platform_user_id=$4 AND user_id=$1',
      [sourceUserId, targetUserId, input.sourcePlatform, input.sourcePlatformUserId]);
    await client.query('DELETE FROM account_link_codes WHERE user_id=$1', [sourceUserId]);
    await client.query('DELETE FROM users WHERE user_id=$1', [sourceUserId]);

    await client.query('COMMIT');
    console.log(redact(`Merged: ${input.sourcePlatform}:${input.sourcePlatformUserId} now belongs to account `
      + `${targetUserId} (was its own empty account ${sourceUserId}, which has been removed).`));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(redact(`Merge failed, no changes made: ${error.message}`));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
