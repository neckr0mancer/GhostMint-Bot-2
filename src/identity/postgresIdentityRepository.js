// Tables holding real user data, keyed by user_id (or an equivalent creator/editor column), that
// must be empty before a duplicate account is safe to remove in mergeAccount below.
const MERGE_DATA_TABLES = [
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

async function findMergeEmptinessViolations(client, userId) {
  const violations = [];

  const governance = await client.query(
    `SELECT group_id,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,
      simulation_forced,selected_preset_key,scheduled_removal_at
     FROM user_governance WHERE user_id=$1`, [userId]);
  if (governance.rowCount) {
    const row = governance.rows[0];
    if (Object.entries(row).some(([key, value]) => key !== 'user_id' && value !== null)) {
      violations.push('user_governance has non-default ceilings/group/preset settings');
    }
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

  for (const [table, column] of MERGE_DATA_TABLES) {
    const result = await client.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE ${column}=$1`, [userId]);
    if (result.rows[0].count > 0) violations.push(`${table}.${column} has ${result.rows[0].count} row(s)`);
  }

  return violations;
}

function createPostgresIdentityRepository(pool) {
  return {
    async resolveOrCreateIdentity({ platform, platformUserId }) {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        const existing = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [platform, platformUserId],
        );
        if (existing.rowCount) {
          await client.query('COMMIT');
          inTransaction = false;
          return existing.rows[0].user_id;
        }
        const user = await client.query('INSERT INTO users DEFAULT VALUES RETURNING user_id');
        try {
          await client.query(
            'INSERT INTO linked_accounts (user_id,platform,platform_user_id) VALUES ($1,$2,$3)',
            [user.rows[0].user_id, platform, platformUserId],
          );
          await client.query('COMMIT');
          inTransaction = false;
          return user.rows[0].user_id;
        } catch (error) {
          if (error.code !== '23505') throw error;
          await client.query('ROLLBACK');
          inTransaction = false;
          const raced = await pool.query(
            'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
            [platform, platformUserId],
          );
          return raced.rows[0].user_id;
        }
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getLinkedAccount(userId, platform) {
      const result = await pool.query(
        'SELECT platform_user_id FROM linked_accounts WHERE user_id=$1 AND platform=$2',
        [userId, platform],
      );
      return result.rows[0]?.platform_user_id || null;
    },

    async listLinkedAccounts(userId) {
      const result = await pool.query(
        'SELECT platform,platform_user_id FROM linked_accounts WHERE user_id=$1 ORDER BY platform',
        [userId],
      );
      return result.rows.map(row => ({ platform: row.platform, platformUserId: row.platform_user_id }));
    },

    async createLinkCode({ userId, codeHash, expiresAt }) {
      await pool.query('DELETE FROM account_link_codes WHERE user_id=$1 AND used_at IS NULL', [userId]);
      await pool.query(
        'INSERT INTO account_link_codes (code_hash,user_id,expires_at) VALUES ($1,$2,TO_TIMESTAMP($3 / 1000.0))',
        [codeHash, userId, expiresAt],
      );
    },

    async consumeLinkCode({ codeHash, platform, platformUserId, now }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await client.query(
          `SELECT user_id FROM account_link_codes
           WHERE code_hash=$1 AND used_at IS NULL AND expires_at > TO_TIMESTAMP($2 / 1000.0)
           FOR UPDATE`,
          [codeHash, now],
        );
        if (!code.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'invalid' };
        }
        const userId = code.rows[0].user_id;
        const linked = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [platform, platformUserId],
        );
        if (linked.rowCount && linked.rows[0].user_id !== userId) {
          await client.query('ROLLBACK');
          return { status: 'conflict' };
        }
        await client.query(
          `INSERT INTO linked_accounts (user_id,platform,platform_user_id) VALUES ($1,$2,$3)
           ON CONFLICT (platform,platform_user_id) DO NOTHING`,
          [userId, platform, platformUserId],
        );
        await client.query('UPDATE account_link_codes SET used_at=NOW() WHERE code_hash=$1', [codeHash]);
        await client.query('COMMIT');
        return { status: 'linked', userId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async consumeLinkCodeForSession({ codeHash, now }) {
      const result = await pool.query(
        `UPDATE account_link_codes SET used_at=NOW()
         WHERE code_hash=$1 AND used_at IS NULL AND expires_at > TO_TIMESTAMP($2 / 1000.0)
         RETURNING user_id`,
        [codeHash, now],
      );
      return result.rowCount ? { status:'linked', userId:result.rows[0].user_id } : { status:'invalid' };
    },

    // Repoints a source platform identity's linked_accounts row onto an existing target account
    // and removes the now-orphaned source account -- but only once verified empty. Both platforms
    // auto-create their own account on first contact (resolveOrCreateIdentity above), so using one
    // platform before it's ever linked to an existing account leaves it stranded on its own
    // separate account; a link code from another platform then correctly refuses to attach to it.
    // Throws a plain Error tagged with .code (SOURCE_NOT_FOUND / TARGET_NOT_FOUND / SAME_ACCOUNT /
    // ACCOUNT_NOT_EMPTY) for every expected refusal reason -- the service layer translates these
    // into a ValidationError with a safe, specific message. A non-empty duplicate is left entirely
    // untouched; this never attempts to move or merge real data.
    async mergeAccount({ sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const source = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [sourcePlatform, sourcePlatformUserId]);
        if (!source.rowCount) {
          const error = new Error(`No linked account found for ${sourcePlatform}:${sourcePlatformUserId}`);
          error.code = 'SOURCE_NOT_FOUND';
          throw error;
        }
        const target = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [targetPlatform, targetPlatformUserId]);
        if (!target.rowCount) {
          const error = new Error(`No linked account found for ${targetPlatform}:${targetPlatformUserId}`);
          error.code = 'TARGET_NOT_FOUND';
          throw error;
        }

        const sourceUserId = source.rows[0].user_id;
        const targetUserId = target.rows[0].user_id;
        if (sourceUserId === targetUserId) {
          const error = new Error('Source and target platform identities already belong to the same account');
          error.code = 'SAME_ACCOUNT';
          throw error;
        }

        const violations = await findMergeEmptinessViolations(client, sourceUserId);
        if (violations.length) {
          const error = new Error(`Source account is not empty, refusing to merge: ${violations.join('; ')}`);
          error.code = 'ACCOUNT_NOT_EMPTY';
          throw error;
        }

        await client.query(
          'UPDATE linked_accounts SET user_id=$2 WHERE platform=$3 AND platform_user_id=$4 AND user_id=$1',
          [sourceUserId, targetUserId, sourcePlatform, sourcePlatformUserId]);
        await client.query('DELETE FROM account_link_codes WHERE user_id=$1', [sourceUserId]);
        await client.query('DELETE FROM users WHERE user_id=$1', [sourceUserId]);

        await client.query('COMMIT');
        return { sourceUserId, targetUserId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getTheme(userId) {
      const result = await pool.query('SELECT dashboard_theme FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.dashboard_theme || 'ghost-mint';
    },

    async setTheme(userId, theme) {
      await pool.query('UPDATE users SET dashboard_theme=$2 WHERE user_id=$1', [userId, theme]);
      return theme;
    },

    async getDisplayName(userId) {
      const result = await pool.query('SELECT display_name FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.display_name || null;
    },

    async setDisplayName(userId, displayName) {
      await pool.query('UPDATE users SET display_name=$2 WHERE user_id=$1', [userId, displayName]);
      return displayName;
    },

    async getDefaultChain(userId) {
      const result = await pool.query('SELECT default_chain FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.default_chain || null;
    },

    async setDefaultChain(userId, defaultChain) {
      await pool.query('UPDATE users SET default_chain=$2 WHERE user_id=$1', [userId, defaultChain]);
      return defaultChain;
    },
  };
}

module.exports = { createPostgresIdentityRepository };
