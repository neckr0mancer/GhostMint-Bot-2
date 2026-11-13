function auditRow(row) {
  return { auditId: row.audit_id, userId: row.user_id, platform: row.platform,
    platformUserId: row.platform_user_id, contextId: row.context_id, command: row.command_name,
    outcome: row.outcome, reason: row.reason, attemptedAt: row.attempted_at };
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function createBotSecurityRepository(pool) {
  return {
    async record(value) {
      await pool.query(`INSERT INTO bot_security_audit
        (user_id,platform,platform_user_id,context_id,command_name,outcome,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[value.userId||null,value.platform,value.platformUserId||null,
        value.contextId||null,String(value.command||'unknown').slice(0,64),value.outcome,String(value.reason||'rejected').slice(0,300)]);
    },

    // Compact newest-first feed used by the personal History surface. The owner Admin register uses
    // listPage below so older evidence remains reachable. `userId` scopes this result to one account;
    // omitting it returns every user's events and is therefore restricted to owner-only callers.
    async listRecent({ limit = 100, userId = null } = {}) {
      const capped = Math.min(Number(limit) || 100, 500);
      const result = userId
        ? await pool.query(`SELECT audit_id,user_id,platform,platform_user_id,context_id,
            command_name,outcome,reason,attempted_at FROM bot_security_audit
            WHERE user_id=$2 ORDER BY attempted_at DESC LIMIT $1`, [capped, userId])
        : await pool.query(`SELECT audit_id,user_id,platform,platform_user_id,context_id,
        command_name,outcome,reason,attempted_at FROM bot_security_audit
        ORDER BY attempted_at DESC LIMIT $1`, [capped]);
      return result.rows.map(auditRow);
    },

    // The owner Audit page is a real pageable register, not a fixed "latest 200" snapshot. Search
    // and outcome filters are resolved in PostgreSQL so older matching evidence is not silently
    // hidden outside a browser-side slice.
    async listPage({ page = 1, pageSize = 25, search = '', outcome = '', userId = null } = {}) {
      const currentPage = positiveInteger(page, 1, Number.MAX_SAFE_INTEGER);
      const size = positiveInteger(pageSize, 25, 100);
      const clauses = [];
      const params = [];
      const add = value => { params.push(value); return `$${params.length}`; };
      if (userId) clauses.push(`user_id=${add(userId)}`);
      const normalizedOutcome = String(outcome || '').trim().toLowerCase();
      if (normalizedOutcome === 'denied') {
        clauses.push(`outcome IN ('failure','rejected','unauthorized','denied')`);
      } else if (normalizedOutcome && normalizedOutcome !== 'all') {
        clauses.push(`outcome=${add(normalizedOutcome)}`);
      }
      const term = String(search || '').trim();
      if (term) {
        const pattern = add(`%${term}%`);
        clauses.push(`(command_name ILIKE ${pattern} OR platform ILIKE ${pattern}
          OR outcome ILIKE ${pattern} OR reason ILIKE ${pattern}
          OR COALESCE(platform_user_id,'') ILIKE ${pattern})`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM bot_security_audit ${where}`, params);
      const total = Number(countResult.rows[0]?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / size));
      const safePage = Math.min(currentPage, totalPages);
      const rowParams = [...params, size, (safePage - 1) * size];
      const limitParam = `$${params.length + 1}`;
      const offsetParam = `$${params.length + 2}`;
      const result = await pool.query(`SELECT audit_id,user_id,platform,platform_user_id,context_id,
        command_name,outcome,reason,attempted_at FROM bot_security_audit ${where}
        ORDER BY attempted_at DESC, audit_id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`, rowParams);
      return { page: safePage, pageSize: size, total, totalPages, items: result.rows.map(auditRow) };
    },
  };
}
module.exports={createBotSecurityRepository};
