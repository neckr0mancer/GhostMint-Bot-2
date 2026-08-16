-- Extends contract_value_cache (see migration 029) with facts about a SeaDrop-based NFT contract:
-- the SeaDrop core contract it has configured as allowed to mint it, and (once known) the
-- PublicDrop pricing/timing/limits and a default allowed fee recipient read from that core
-- contract. Same (chain, contract_address) key as the rest of the table -- this is more resolved
-- facts about the same contract, not a different subject. A NULL seadrop_address with a non-NULL
-- seadrop_resolved_at means discovery was attempted and found nothing, not that it hasn't been
-- attempted yet -- same convention as the rest of this table (see migration 029's header comment).
ALTER TABLE contract_value_cache
  ADD COLUMN seadrop_address TEXT,
  ADD COLUMN seadrop_discovery_source TEXT,
  ADD COLUMN seadrop_fee_recipient TEXT,
  ADD COLUMN seadrop_mint_price_wei NUMERIC(78,0),
  ADD COLUMN seadrop_start_time BIGINT,
  ADD COLUMN seadrop_end_time BIGINT,
  ADD COLUMN seadrop_max_total_mintable_by_wallet INTEGER,
  ADD COLUMN seadrop_fee_bps INTEGER,
  ADD COLUMN seadrop_restrict_fee_recipients BOOLEAN,
  ADD COLUMN seadrop_resolved_at TIMESTAMPTZ;
