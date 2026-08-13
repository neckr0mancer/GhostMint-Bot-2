function createBotSecurityRepository(pool) {
  return {
    async record(value) {
      await pool.query(`INSERT INTO bot_security_audit
        (user_id,platform,platform_user_id,context_id,command_name,outcome,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[value.userId||null,value.platform,value.platformUserId||null,
        value.contextId||null,String(value.command||'unknown').slice(0,64),value.outcome,String(value.reason||'rejected').slice(0,300)]);
    },
  };
}
module.exports={createBotSecurityRepository};
