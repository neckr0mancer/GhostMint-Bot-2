'use strict';

function mapAuthorization(row) {
  if (!row) return null;
  return {
    walletId:Number(row.wallet_id),
    userId:row.user_id,
    walletAddress:row.wallet_address,
    scopedTokenId:row.scoped_token_id,
    tokenEnvelope:{
      ciphertext:row.encrypted_scoped_token,
      salt:row.encryption_salt,
      nonce:row.encryption_nonce,
      authTag:row.encryption_auth_tag,
      keyVersion:Number(row.encryption_key_version),
    },
    scopes:row.scopes || [],
    expiresAt:new Date(row.expires_at).getTime(),
    createdAt:new Date(row.created_at).getTime(),
    updatedAt:new Date(row.updated_at).getTime(),
    lastUsedAt:row.last_used_at ? new Date(row.last_used_at).getTime() : null,
    lastError:row.last_error_code || null,
  };
}

function createOpenSeaEligibilityRepository(pool) {
  return {
    async get(userId,walletId) {
      const result=await pool.query(`SELECT * FROM opensea_wallet_eligibility_authorizations
        WHERE user_id=$1 AND wallet_id=$2`,[userId,walletId]);
      return mapAuthorization(result.rows[0]);
    },
    async save({userId,walletId,walletAddress,scopedTokenId,tokenEnvelope,expiresAt}) {
      const result=await pool.query(`INSERT INTO opensea_wallet_eligibility_authorizations
        (wallet_id,user_id,wallet_address,scoped_token_id,encrypted_scoped_token,encryption_salt,
         encryption_nonce,encryption_auth_tag,encryption_key_version,scopes,expires_at,last_error_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY['read:eligibility']::TEXT[],$10,NULL)
        ON CONFLICT (user_id,wallet_id) DO UPDATE SET
          user_id=EXCLUDED.user_id,wallet_address=EXCLUDED.wallet_address,
          scoped_token_id=EXCLUDED.scoped_token_id,
          encrypted_scoped_token=EXCLUDED.encrypted_scoped_token,
          encryption_salt=EXCLUDED.encryption_salt,encryption_nonce=EXCLUDED.encryption_nonce,
          encryption_auth_tag=EXCLUDED.encryption_auth_tag,
          encryption_key_version=EXCLUDED.encryption_key_version,
          scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,updated_at=NOW(),last_error_code=NULL
        RETURNING *`,[walletId,userId,walletAddress,scopedTokenId,
        tokenEnvelope.ciphertext,tokenEnvelope.salt,tokenEnvelope.nonce,tokenEnvelope.authTag,
        tokenEnvelope.keyVersion,new Date(expiresAt)]);
      return mapAuthorization(result.rows[0]);
    },
    async markUsed(userId,walletId) {
      await pool.query(`UPDATE opensea_wallet_eligibility_authorizations
        SET last_used_at=NOW(),last_error_code=NULL,updated_at=NOW()
        WHERE user_id=$1 AND wallet_id=$2`,[userId,walletId]);
    },
    async markError(userId,walletId,code) {
      await pool.query(`UPDATE opensea_wallet_eligibility_authorizations
        SET last_error_code=$3,updated_at=NOW() WHERE user_id=$1 AND wallet_id=$2`,
      [userId,walletId,String(code||'OPENSEA_ELIGIBILITY_UNAVAILABLE').slice(0,80)]);
    },
    async remove(userId,walletId) {
      const result=await pool.query(`DELETE FROM opensea_wallet_eligibility_authorizations
        WHERE user_id=$1 AND wallet_id=$2 RETURNING *`,[userId,walletId]);
      return mapAuthorization(result.rows[0]);
    },
  };
}

module.exports={createOpenSeaEligibilityRepository,mapAuthorization};
