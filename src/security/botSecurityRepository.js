function createBotSecurityRepository(pool) {
  return {
    async record(value) {
      await pool.query(`INSERT INTO bot_security_audit
        (user_id,platform,platform_user_id,context_id,command_name,outcome,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[value.userId||null,value.platform,value.platformUserId||null,
        value.contextId||null,String(value.command||'unknown').slice(0,64),value.outcome,String(value.reason||'rejected').slice(0,300)]);
    },

    // Owner-only audit view -- newest first, capped so the admin dashboard never has to page
    // through the whole table.
    // `userId` scopes the result to one account. Without it this returns EVERY user's security
    // events, which is correct for the admin view and wrong everywhere else -- the dashboard's
    // personal History tab was rendering the platform-wide feed because there was no way to ask
    // for anything narrower.
    async listRecent({ limit = 100, userId = null } = {}) {
      const capped = Math.min(Number(limit) || 100, 500);
      const result = userId
        ? await pool.query(`SELECT audit_id,user_id,platform,platform_user_id,context_id,
            command_name,outcome,reason,attempted_at FROM bot_security_audit
            WHERE user_id=$2 ORDER BY attempted_at DESC LIMIT $1`, [capped, userId])
        : await pool.query(`SELECT audit_id,user_id,platform,platform_user_id,context_id,
        command_name,outcome,reason,attempted_at FROM bot_security_audit
        ORDER BY attempted_at DESC LIMIT $1`, [capped]);
      return result.rows.map(row => ({ auditId: row.audit_id, userId: row.user_id, platform: row.platform,
        platformUserId: row.platform_user_id, contextId: row.context_id, command: row.command_name,
        outcome: row.outcome, reason: row.reason, attemptedAt: row.attempted_at }));
    },
  };
}
module.exports={createBotSecurityRepository};
