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

    async getTheme(userId) {
      const result = await pool.query('SELECT dashboard_theme FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.dashboard_theme || 'ghost-mint';
    },

    async setTheme(userId, theme) {
      await pool.query('UPDATE users SET dashboard_theme=$2 WHERE user_id=$1', [userId, theme]);
      return theme;
    },
  };
}

module.exports = { createPostgresIdentityRepository };
