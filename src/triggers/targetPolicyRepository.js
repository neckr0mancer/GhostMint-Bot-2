function mapPolicy(row) {
  if (!row) return null;
  return { id:row.policy_id,userId:row.user_id,targetType:row.target_type,targetId:row.target_id,
    blockchainTrigger:row.blockchain_trigger_mode,socialTrigger:row.social_trigger_mode,
    humanVerification:row.human_verification,dontAskAgain:row.dont_ask_again,
    walletLabel:row.wallet_label,mintPresetName:row.mint_preset_name,modePresetKey:row.mode_preset_key };
}
function mapRequest(row) {
  if (!row) return null;
  return { id:row.request_id,userId:row.user_id,targetType:row.target_type,targetId:row.target_id,
    triggerSource:row.trigger_source,sourceEventId:row.source_event_id,preview:row.preview,
    executionPayload:row.execution_payload,status:row.status,expiresAt:new Date(row.expires_at).getTime() };
}
function mapAudit(row) {
  if (!row) return null;
  const executedAt = row.executed_at == null ? null : new Date(row.executed_at);
  return {
    auditId:String(row.audit_id),userId:row.user_id,targetType:row.target_type,targetId:row.target_id,
    triggerSource:row.trigger_source,sourceEventId:row.source_event_id,
    verificationState:row.verification_state,dontAskAgainActive:row.dont_ask_again_active,
    confirmationShown:row.confirmation_shown,transactionIntentId:row.transaction_intent_id,
    transactionHash:row.transaction_hash,chain:row.chain||null,outcome:row.outcome,
    executedAt:executedAt && !Number.isNaN(executedAt.getTime()) ? executedAt.toISOString() : null,
  };
}
function createTargetPolicyRepository(pool) {
  return {
    async get(userId,targetType,targetId) { const r=await pool.query(`SELECT * FROM target_trigger_policies
      WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,[userId,targetType,targetId]); return mapPolicy(r.rows[0]); },
    async save(value) { const r=await pool.query(`INSERT INTO target_trigger_policies
      (user_id,target_type,target_id,blockchain_trigger_mode,social_trigger_mode,human_verification,
        dont_ask_again,wallet_label,mint_preset_name,mode_preset_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id,target_type,target_id) DO UPDATE SET blockchain_trigger_mode=$4,
      social_trigger_mode=$5,human_verification=$6,dont_ask_again=$7,wallet_label=$8,
      mint_preset_name=$9,mode_preset_key=$10,updated_at=NOW() RETURNING *`,[value.userId,value.targetType,value.targetId,
      value.blockchainTrigger,value.socialTrigger,value.humanVerification,value.dontAskAgain,
      value.walletLabel,value.mintPresetName,value.modePresetKey||null]); return mapPolicy(r.rows[0]); },
    async reset(userId,targetType,targetId) {
      await pool.query(`DELETE FROM target_bypass_challenges WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,[userId,targetType,targetId]);
      await pool.query(`DELETE FROM trigger_execution_requests WHERE user_id=$1 AND target_type=$2 AND target_id=$3
        AND status IN ('pending','executing')`,[userId,targetType,targetId]);
      await pool.query(`DELETE FROM target_trigger_policies WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,[userId,targetType,targetId]);
    },
    async createChallenge(value) { const r=await pool.query(`INSERT INTO target_bypass_challenges
      (user_id,target_type,target_id,dont_ask_again,expires_at) VALUES ($1,$2,$3,$4,TO_TIMESTAMP($5/1000.0)) RETURNING challenge_id`,
    [value.userId,value.targetType,value.targetId,value.dontAskAgain,value.expiresAt]); return r.rows[0].challenge_id; },
    async consumeChallenge(userId,id,now) { const r=await pool.query(`UPDATE target_bypass_challenges SET used_at=NOW()
      WHERE challenge_id=$1 AND user_id=$2 AND used_at IS NULL AND expires_at>TO_TIMESTAMP($3/1000.0) RETURNING *`,[id,userId,now]); return r.rows[0]||null; },
    async createRequest(value) { const r=await pool.query(`INSERT INTO trigger_execution_requests
      (user_id,target_type,target_id,trigger_source,source_event_id,preview,execution_payload,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7::JSONB,TO_TIMESTAMP($8/1000.0))
      ON CONFLICT (user_id,target_type,target_id,trigger_source,source_event_id) DO UPDATE SET
      preview=EXCLUDED.preview RETURNING *`,[value.userId,value.targetType,value.targetId,value.triggerSource,
      value.sourceEventId,JSON.stringify(value.preview),JSON.stringify(value.executionPayload),value.expiresAt]); return mapRequest(r.rows[0]); },
    async claimRequest(userId,id,now) { const r=await pool.query(`UPDATE trigger_execution_requests SET status='executing'
      WHERE request_id=$1 AND user_id=$2 AND status='pending' AND expires_at>TO_TIMESTAMP($3/1000.0) RETURNING *`,[id,userId,now]); return mapRequest(r.rows[0]); },
    async finishRequest(id,outcome) { await pool.query(`UPDATE trigger_execution_requests SET status=$2,completed_at=NOW() WHERE request_id=$1`,[id,outcome]); },
    async rejectRequest(userId,id,now) { const r=await pool.query(`UPDATE trigger_execution_requests
      SET status='rejected',completed_at=NOW() WHERE request_id=$1 AND user_id=$2 AND status='pending'
      AND expires_at>TO_TIMESTAMP($3/1000.0) RETURNING *`,[id,userId,now]); return mapRequest(r.rows[0]); },
    async addAudit(value) { await pool.query(`INSERT INTO trigger_execution_audit
      (user_id,target_type,target_id,trigger_source,source_event_id,verification_state,dont_ask_again_active,
       confirmation_shown,transaction_intent_id,transaction_hash,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [value.userId,value.targetType,value.targetId,value.triggerSource,value.sourceEventId,value.verificationState,
      value.dontAskAgain,value.confirmationShown,value.intentId||null,value.txHash||null,value.outcome]); },
    async listAudit(userId,limit=20) { const r=await pool.query(`SELECT * FROM trigger_execution_audit WHERE user_id=$1
      ORDER BY executed_at DESC LIMIT $2`,[userId,limit]); return r.rows; },
    async listAuditPage(userId,{limit=10,offset=0,search=''}) {
      const normalizedSearch=String(search||'').trim();
      const term=normalizedSearch?`%${normalizedSearch}%`:null;
      const predicate=term?`WHERE audit.user_id=$1 AND (
        audit.trigger_source ILIKE $4 OR audit.source_event_id ILIKE $4 OR
        audit.target_type ILIKE $4 OR audit.target_id::TEXT ILIKE $4 OR
        COALESCE(audit.transaction_hash,'') ILIKE $4 OR audit.outcome ILIKE $4 OR
        audit.verification_state ILIKE $4
      )`:'WHERE audit.user_id=$1';
      const rowParams=term?[userId,limit,offset,term]:[userId,limit,offset];
      const countPredicate=term?predicate.replaceAll('$4','$2'):predicate;
      const countParams=term?[userId,term]:[userId];
      const [rows,count]=await Promise.all([
        pool.query(`SELECT audit.*,intent.chain FROM trigger_execution_audit audit
          LEFT JOIN transaction_intents intent ON intent.intent_id=audit.transaction_intent_id
            AND intent.user_id=audit.user_id
          ${predicate} ORDER BY audit.executed_at DESC,audit.audit_id DESC LIMIT $2 OFFSET $3`,rowParams),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM trigger_execution_audit audit ${countPredicate}`,
          countParams),
      ]);
      return {items:rows.rows.map(mapAudit),total:Number(count.rows[0]?.total||0)};
    },
    async listPendingRequests(userId,limit=20) { const r=await pool.query(`SELECT * FROM trigger_execution_requests
      WHERE user_id=$1 AND status='pending' AND expires_at>NOW() ORDER BY created_at DESC LIMIT $2`,[userId,limit]);
      return r.rows.map(mapRequest); },
  };
}
module.exports={createTargetPolicyRepository,mapPolicy,mapRequest,mapAudit};
