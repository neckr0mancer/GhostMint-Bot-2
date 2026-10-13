-- Provider-independent, address-backed wallet history. This migration only creates the durable
-- storage and provenance boundaries; it does not configure a chain-indexing provider or claim
-- that any wallet has complete history yet.

CREATE TABLE wallet_history_subjects (
  user_id UUID NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tracking_start_block BIGINT,
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chain, wallet_address),
  CHECK (chain = LOWER(chain) AND chain <> ''),
  CHECK (wallet_address = LOWER(wallet_address) AND wallet_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (tracking_start_block IS NULL OR tracking_start_block >= 0)
);

CREATE INDEX wallet_history_subjects_address_idx
  ON wallet_history_subjects (chain, wallet_address);

CREATE TABLE wallet_history_sync_state (
  user_id UUID NOT NULL,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  provider_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','backfilling','current','partial','unsupported','error')),
  cursor JSONB,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  history_complete_from_block BIGINT,
  history_complete_through_block BIGINT,
  provenance_complete_from_block BIGINT,
  provenance_complete_through_block BIGINT,
  finalized_through_block BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_requested_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  retry_after TIMESTAMPTZ,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chain, wallet_address),
  FOREIGN KEY (user_id, chain, wallet_address)
    REFERENCES wallet_history_subjects(user_id, chain, wallet_address)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (provider_key IS NULL OR (provider_key = LOWER(provider_key) AND provider_key <> '')),
  CHECK (history_complete_from_block IS NULL OR history_complete_from_block >= 0),
  CHECK (history_complete_through_block IS NULL OR history_complete_through_block >= 0),
  CHECK (provenance_complete_from_block IS NULL OR provenance_complete_from_block >= 0),
  CHECK (provenance_complete_through_block IS NULL OR provenance_complete_through_block >= 0),
  CHECK (finalized_through_block IS NULL OR finalized_through_block >= 0),
  CHECK (history_complete_from_block IS NULL OR history_complete_through_block IS NULL
    OR history_complete_from_block <= history_complete_through_block),
  CHECK (provenance_complete_from_block IS NULL OR provenance_complete_through_block IS NULL
    OR provenance_complete_from_block <= provenance_complete_through_block),
  CHECK (claimed_by IS NULL OR claimed_by <> ''),
  CHECK ((claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX wallet_history_sync_state_retry_idx
  ON wallet_history_sync_state (state, retry_after, lease_expires_at, last_requested_at)
  WHERE state IN ('queued','backfilling','error');

CREATE TABLE wallet_history_transactions (
  user_id UUID NOT NULL,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT,
  transaction_index INTEGER CHECK (transaction_index IS NULL OR transaction_index >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  nonce NUMERIC(78,0),
  input TEXT,
  method_selector TEXT,
  value_wei NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (value_wei >= 0),
  gas_limit NUMERIC(78,0),
  gas_used NUMERIC(78,0),
  effective_gas_price_wei NUMERIC(78,0),
  network_fee_wei NUMERIC(78,0),
  execution_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (execution_status IN ('success','reverted','unknown')),
  finality_status TEXT NOT NULL DEFAULT 'unfinalized'
    CHECK (finality_status IN ('unfinalized','finalized')),
  canonical BOOLEAN NOT NULL DEFAULT TRUE,
  orphaned_at TIMESTAMPTZ,
  provider_key TEXT NOT NULL,
  provider_complete BOOLEAN NOT NULL DEFAULT FALSE,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  raw_summary JSONB,
  PRIMARY KEY (user_id, chain, wallet_address, tx_hash),
  FOREIGN KEY (user_id, chain, wallet_address)
    REFERENCES wallet_history_subjects(user_id, chain, wallet_address)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (tx_hash = LOWER(tx_hash) AND tx_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK (from_address = LOWER(from_address) AND from_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (to_address IS NULL OR (to_address = LOWER(to_address) AND to_address ~ '^0x[0-9a-f]{40}$')),
  CHECK (block_hash IS NULL OR (block_hash = LOWER(block_hash) AND block_hash ~ '^0x[0-9a-f]{64}$')),
  CHECK (method_selector IS NULL OR (method_selector = LOWER(method_selector)
    AND method_selector ~ '^0x[0-9a-f]{8}$')),
  CHECK (nonce IS NULL OR nonce >= 0),
  CHECK (gas_limit IS NULL OR gas_limit >= 0),
  CHECK (gas_used IS NULL OR gas_used >= 0),
  CHECK (effective_gas_price_wei IS NULL OR effective_gas_price_wei >= 0),
  CHECK (network_fee_wei IS NULL OR network_fee_wei >= 0),
  CHECK (provider_key = LOWER(provider_key) AND provider_key <> '')
);

CREATE INDEX wallet_history_transactions_page_idx
  ON wallet_history_transactions
  (user_id, chain, wallet_address, occurred_at DESC, block_number DESC, transaction_index DESC, tx_hash DESC)
  WHERE canonical = TRUE;
CREATE INDEX wallet_history_transactions_hash_idx
  ON wallet_history_transactions (user_id, tx_hash);
CREATE INDEX wallet_history_transactions_from_idx
  ON wallet_history_transactions (user_id, chain, from_address, tx_hash);

CREATE TABLE wallet_history_movements (
  user_id UUID NOT NULL,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_locator TEXT NOT NULL,
  event_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out','self','unknown')),
  asset_standard TEXT NOT NULL DEFAULT 'native'
    CHECK (asset_standard IN ('native','erc20','erc721','erc1155','unknown')),
  asset_address TEXT,
  token_id NUMERIC(78,0),
  amount_raw NUMERIC(78,0),
  from_address TEXT,
  to_address TEXT,
  details JSONB,
  PRIMARY KEY (user_id, chain, wallet_address, tx_hash, event_locator),
  FOREIGN KEY (user_id, chain, wallet_address, tx_hash)
    REFERENCES wallet_history_transactions(user_id, chain, wallet_address, tx_hash)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (event_locator <> ''),
  CHECK (event_type <> ''),
  CHECK (asset_address IS NULL OR (asset_address = LOWER(asset_address)
    AND asset_address ~ '^0x[0-9a-f]{40}$')),
  CHECK (from_address IS NULL OR (from_address = LOWER(from_address)
    AND from_address ~ '^0x[0-9a-f]{40}$')),
  CHECK (to_address IS NULL OR (to_address = LOWER(to_address)
    AND to_address ~ '^0x[0-9a-f]{40}$')),
  CHECK (token_id IS NULL OR token_id >= 0),
  CHECK (amount_raw IS NULL OR amount_raw >= 0)
);

CREATE INDEX wallet_history_movements_asset_idx
  ON wallet_history_movements (user_id, chain, asset_address, token_id);

-- History provenance must be able to match every hash GhostMint durably associates with an
-- intent. These indexes keep that classification address-scoped and cheap without denormalizing
-- an author-controlled source label into imported history.
CREATE INDEX IF NOT EXISTS transaction_intents_replacement_hash_lookup_idx
  ON transaction_intents (user_id, chain, LOWER(from_address), LOWER(replacement_tx_hash))
  WHERE replacement_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_intents_bumped_hash_lookup_idx
  ON transaction_intents (user_id, chain, LOWER(from_address), LOWER(bumped_from_tx_hash))
  WHERE bumped_from_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_intents_primary_hash_lookup_idx
  ON transaction_intents (user_id, chain, LOWER(from_address), LOWER(tx_hash))
  WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_broadcast_hashes_hash_lookup_idx
  ON transaction_broadcast_hashes (LOWER(tx_hash), intent_id);

-- Account deletion must remove every hash that could otherwise survive as stale provenance.
ALTER TABLE transaction_broadcast_hashes
  DROP CONSTRAINT IF EXISTS transaction_broadcast_hashes_intent_id_fkey;
ALTER TABLE transaction_broadcast_hashes
  ADD CONSTRAINT transaction_broadcast_hashes_intent_id_fkey
  FOREIGN KEY (intent_id) REFERENCES transaction_intents(intent_id) ON DELETE CASCADE;
