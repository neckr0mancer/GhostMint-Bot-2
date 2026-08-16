-- Caches price/supply/per-wallet-limit values resolved by probing common view function names on
-- an NFT contract (ERC-721 does not standardize these). A NULL value column means that value was
-- probed and came back unknown (missing or reverting function), not that it hasn't been probed yet
-- -- resolved_at is what distinguishes "not yet probed" (no row) from "probed, unknown" (row with
-- NULLs). *_source records which candidate function name answered, for troubleshooting.
-- contract_address is always stored lowercased by the repository layer (application-level
-- normalization), so a plain PRIMARY KEY is enough for case-insensitive lookups without needing an
-- expression index.
CREATE TABLE contract_value_cache (
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  price_wei NUMERIC(78,0),
  price_source TEXT,
  max_supply NUMERIC(78,0),
  supply_source TEXT,
  max_per_wallet NUMERIC(78,0),
  per_wallet_source TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, contract_address)
);
