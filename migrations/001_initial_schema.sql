CREATE TABLE wallets (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  encryption_salt TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  encryption_auth_tag TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version > 0),
  minted INTEGER NOT NULL DEFAULT 0 CHECK (minted >= 0),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wallets_address_idx ON wallets (LOWER(address));

CREATE TABLE mint_tasks (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  wallet_label TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  function_name TEXT NOT NULL DEFAULT 'mint',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_eth NUMERIC NOT NULL DEFAULT 0,
  gas_gwei NUMERIC,
  mint_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mint_tasks_status_idx ON mint_tasks (status);
CREATE INDEX mint_tasks_mint_time_idx ON mint_tasks (mint_time);
CREATE INDEX mint_tasks_status_mint_time_idx ON mint_tasks (status, mint_time);

CREATE TABLE activity (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  wallet_label TEXT,
  tx_hash TEXT,
  explorer TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX activity_occurred_at_idx ON activity (occurred_at DESC);
CREATE INDEX activity_wallet_label_idx ON activity (wallet_label);

CREATE TABLE pnl_records (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cost NUMERIC NOT NULL DEFAULT 0,
  sale NUMERIC NOT NULL DEFAULT 0,
  gas NUMERIC NOT NULL DEFAULT 0,
  net NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE snipers (
  id BIGINT PRIMARY KEY,
  label TEXT NOT NULL,
  target_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  wallet_label TEXT NOT NULL,
  value_mode TEXT NOT NULL DEFAULT 'copy',
  fixed_value_eth NUMERIC NOT NULL DEFAULT 0,
  max_value_eth NUMERIC,
  gas_boost_percent INTEGER NOT NULL DEFAULT 20,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  fails INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX snipers_active_chain_idx ON snipers (active, chain);
CREATE INDEX snipers_target_address_idx ON snipers (LOWER(target_address));

CREATE TABLE sniper_seen_transactions (
  sniper_id BIGINT NOT NULL REFERENCES snipers(id) ON DELETE CASCADE,
  tx_hash TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sniper_id, tx_hash)
);

CREATE INDEX sniper_seen_transactions_seen_at_idx ON sniper_seen_transactions (seen_at);

CREATE TABLE app_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
