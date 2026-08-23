function createDashboardSessionRepository(pool) {
  return {
    async create({userId,tokenHash,csrfTokenHash,expiresAt,maxActiveSessions=3,clientLabel=null,now=Date.now(),maxLifetimeMs=null}) {
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        // Lock the account, not merely the current session rows: this also serializes two first
        // logins that arrive while the account has no active sessions yet.
        await client.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[userId]);
        await client.query(`UPDATE dashboard_sessions SET revoked_at=NOW(),revoked_reason='session_limit'
          WHERE session_id IN (
            SELECT session_id FROM dashboard_sessions
            WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()
              AND ($4::BIGINT IS NULL OR created_at>TO_TIMESTAMP(($3-$4)/1000.0))
            ORDER BY last_seen_at DESC,created_at DESC
            OFFSET $2
          )`,[userId,Math.max(0,maxActiveSessions-1),now,maxLifetimeMs]);
        const result=await client.query(`INSERT INTO dashboard_sessions
          (user_id,token_hash,csrf_token_hash,expires_at,client_label)
          VALUES ($1,$2,$3,TO_TIMESTAMP($4/1000.0),$5) RETURNING session_id`,
        [userId,tokenHash,csrfTokenHash,expiresAt,clientLabel]);
        await client.query('COMMIT');
        return result.rows[0].session_id;
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
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
    async denialReason(tokenHash,now,maxLifetimeMs){
      const result=await pool.query(`SELECT expires_at,created_at,revoked_at,revoked_reason
        FROM dashboard_sessions WHERE token_hash=$1`,[tokenHash]);
      if(!result.rowCount)return 'invalid';
      const row=result.rows[0];
      if(row.revoked_at)return row.revoked_reason||'revoked';
      if(maxLifetimeMs!=null&&new Date(row.created_at).getTime()<=now-maxLifetimeMs)return 'absolute_expired';
      if(new Date(row.expires_at).getTime()<=now)return 'idle_expired';
      return 'invalid';
    },
    async summary(userId,sessionId,now,maxLifetimeMs){
      const result=await pool.query(`SELECT
        COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at>TO_TIMESTAMP($3/1000.0)
          AND ($4::BIGINT IS NULL OR created_at>TO_TIMESTAMP(($3-$4)/1000.0)))::INTEGER AS active_count,
        MAX(expires_at) FILTER (WHERE session_id=$2) AS current_expires_at,
        MAX(created_at) FILTER (WHERE session_id=$2) AS current_created_at,
        MAX(client_label) FILTER (WHERE session_id=$2) AS current_client_label
        FROM dashboard_sessions WHERE user_id=$1`,[userId,sessionId,now,maxLifetimeMs??null]);
      const row=result.rows[0];
      return {activeCount:row.active_count||0,expiresAt:row.current_expires_at?new Date(row.current_expires_at).getTime():null,
        createdAt:row.current_created_at?new Date(row.current_created_at).getTime():null,clientLabel:row.current_client_label||null};
    },
    async revoke(sessionId,reason='logout') {const result=await pool.query('UPDATE dashboard_sessions SET revoked_at=NOW(),revoked_reason=$2 WHERE session_id=$1 AND revoked_at IS NULL',[sessionId,reason]);return result.rowCount>0;},
    async revokeAll(userId,reason='logout_all') {const result=await pool.query('UPDATE dashboard_sessions SET revoked_at=NOW(),revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL',[userId,reason]);return result.rowCount;},
  };
}
module.exports={createDashboardSessionRepository};
