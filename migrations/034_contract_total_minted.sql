-- Extends contract_value_cache (see migration 029) with a distinct "current minted count" reading,
-- separate from max_supply (whose own resolver falls back to totalSupply() as a stand-in for a
-- fixed cap on contracts with no dedicated max-supply getter). Comparing this against max_supply
-- is what lets the contract-details display tell a sold-out collection apart from one still
-- minting, without conflating the two concepts under one column.
ALTER TABLE contract_value_cache
  ADD COLUMN total_minted NUMERIC(78,0),
  ADD COLUMN total_minted_source TEXT;
