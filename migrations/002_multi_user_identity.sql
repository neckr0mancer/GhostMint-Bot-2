CREATE TYPE linked_account_platform AS ENUM ('telegram', 'discord');

CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE linked_accounts (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  platform linked_account_platform NOT NULL,
  platform_user_id TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, platform),
  UNIQUE (platform, platform_user_id),
  CHECK (platform_user_id <> '')
);

CREATE INDEX linked_accounts_user_id_idx ON linked_accounts (user_id);

CREATE TABLE account_link_codes (
  code_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX account_link_codes_user_expiry_idx ON account_link_codes (user_id, expires_at DESC);

ALTER TABLE wallets ADD COLUMN user_id UUID REFERENCES users(user_id);
ALTER TABLE mint_tasks ADD COLUMN user_id UUID REFERENCES users(user_id);
ALTER TABLE activity ADD COLUMN user_id UUID REFERENCES users(user_id);
ALTER TABLE pnl_records ADD COLUMN user_id UUID REFERENCES users(user_id);
ALTER TABLE snipers ADD COLUMN user_id UUID REFERENCES users(user_id);
ALTER TABLE sniper_seen_transactions ADD COLUMN user_id UUID REFERENCES users(user_id);

DO $$
DECLARE
  legacy_user_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM wallets)
    OR EXISTS (SELECT 1 FROM mint_tasks)
    OR EXISTS (SELECT 1 FROM activity)
    OR EXISTS (SELECT 1 FROM pnl_records)
    OR EXISTS (SELECT 1 FROM snipers)
    OR EXISTS (SELECT 1 FROM sniper_seen_transactions) THEN
    INSERT INTO users DEFAULT VALUES RETURNING user_id INTO legacy_user_id;
    UPDATE wallets SET user_id = legacy_user_id;
    UPDATE mint_tasks SET user_id = legacy_user_id;
    UPDATE activity SET user_id = legacy_user_id;
    UPDATE pnl_records SET user_id = legacy_user_id;
    UPDATE snipers SET user_id = legacy_user_id;
    UPDATE sniper_seen_transactions seen
      SET user_id = COALESCE(
        (SELECT sniper.user_id FROM snipers sniper WHERE sniper.id = seen.sniper_id),
        legacy_user_id
      );
  END IF;
END $$;

ALTER TABLE wallets ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE mint_tasks ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE activity ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE pnl_records ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE snipers ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE sniper_seen_transactions ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE wallets DROP CONSTRAINT wallets_label_key;
ALTER TABLE wallets ADD CONSTRAINT wallets_user_label_key UNIQUE (user_id, label);

ALTER TABLE mint_tasks DROP CONSTRAINT mint_tasks_pkey;
ALTER TABLE mint_tasks ADD PRIMARY KEY (user_id, id);

ALTER TABLE sniper_seen_transactions DROP CONSTRAINT sniper_seen_transactions_sniper_id_fkey;
ALTER TABLE sniper_seen_transactions DROP CONSTRAINT sniper_seen_transactions_pkey;
ALTER TABLE snipers DROP CONSTRAINT snipers_pkey;
ALTER TABLE snipers ADD PRIMARY KEY (user_id, id);
ALTER TABLE sniper_seen_transactions ADD PRIMARY KEY (user_id, sniper_id, tx_hash);
ALTER TABLE sniper_seen_transactions ADD CONSTRAINT sniper_seen_transactions_owner_fkey
  FOREIGN KEY (user_id, sniper_id) REFERENCES snipers(user_id, id) ON DELETE CASCADE;

CREATE INDEX wallets_user_address_idx ON wallets (user_id, LOWER(address));
CREATE INDEX mint_tasks_user_status_time_idx ON mint_tasks (user_id, status, mint_time);
CREATE INDEX activity_user_time_idx ON activity (user_id, occurred_at DESC);
CREATE INDEX pnl_records_user_time_idx ON pnl_records (user_id, created_at DESC);
CREATE INDEX snipers_user_active_chain_idx ON snipers (user_id, active, chain);
CREATE INDEX sniper_seen_transactions_user_seen_idx
  ON sniper_seen_transactions (user_id, seen_at DESC);

DROP TABLE sessions;
DROP TABLE app_users;
