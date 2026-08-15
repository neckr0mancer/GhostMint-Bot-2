function createDashboardSessionRepository(pool) {
  return {
    async create({userId,tokenHash,csrfTokenHash,expiresAt}) {
      const result=await pool.query(`INSERT INTO dashboard_sessions
        (user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,TO_TIMESTAMP($4/1000.0)) RETURNING session_id`,
      [userId,tokenHash,csrfTokenHash,expiresAt]);
      return result.rows[0].session_id;
    },
    // extendByMs slides expires_at forward on every call (an idle timeout: stay signed in by staying
    // active). maxLifetimeMs is an absolute cap measured from created_at that sliding can never push
    // past, so a session that's kept "alive" by continuous use for weeks still forces a re-login
    // eventually -- without maxLifetimeMs, extendByMs alone never expires a session in active use.
    async resolve(tokenHash,now,extendByMs,maxLifetimeMs) {
      const result=await pool.query(`UPDATE dashboard_sessions SET last_seen_at=NOW(),
        expires_at=TO_TIMESTAMP($3/1000.0)
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>TO_TIMESTAMP($2/1000.0)
          AND ($4::BIGINT IS NULL OR created_at>TO_TIMESTAMP(($2-$4)/1000.0))
        RETURNING session_id,user_id,csrf_token_hash,expires_at`,[tokenHash,now,now+extendByMs,maxLifetimeMs??null]);
      if(!result.rowCount)return null;
      const row=result.rows[0];
      return {sessionId:row.session_id,userId:row.user_id,csrfTokenHash:row.csrf_token_hash,expiresAt:new Date(row.expires_at).getTime()};
    },
    async revoke(sessionId) {const result=await pool.query('UPDATE dashboard_sessions SET revoked_at=NOW() WHERE session_id=$1 AND revoked_at IS NULL',[sessionId]);return result.rowCount>0;},
    async revokeAll(userId) {const result=await pool.query('UPDATE dashboard_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);return result.rowCount;},
  };
}
module.exports={createDashboardSessionRepository};
