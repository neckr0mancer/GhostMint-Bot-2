CREATE TABLE IF NOT EXISTS opensea_wallet_eligibility_authorizations (
  user_id UUID NOT NULL,
  wallet_id BIGINT NOT NULL,
  wallet_address TEXT NOT NULL,
  scoped_token_id TEXT NOT NULL,
  encrypted_scoped_token TEXT NOT NULL,
  encryption_salt TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  encryption_auth_tag TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read:eligibility']::TEXT[],
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  last_error_code TEXT,
  PRIMARY KEY (user_id, wallet_id),
  CONSTRAINT opensea_wallet_eligibility_wallet_owner_fk
    FOREIGN KEY (user_id, wallet_id) REFERENCES wallets(user_id, id) ON DELETE CASCADE,
  CONSTRAINT opensea_wallet_eligibility_scopes_check
    CHECK (scopes = ARRAY['read:eligibility']::TEXT[])
);

CREATE INDEX IF NOT EXISTS opensea_wallet_eligibility_user_idx
  ON opensea_wallet_eligibility_authorizations(user_id);
