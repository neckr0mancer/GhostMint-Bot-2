-- Extends contract_value_cache (see migration 029) with OpenSea collection metadata for the same
-- (chain, contract_address) subject -- display-only facts (name, image, description, floor price)
-- used to show contract details, never consulted for spend/gas ceilings or mint execution. A NULL
-- opensea_name with a non-NULL opensea_resolved_at means the lookup was attempted and OpenSea had
-- nothing for this contract (unsupported chain, no API key configured, or genuinely unlisted), not
-- that it hasn't been attempted yet -- same convention as the seadrop_* and price_wei columns.
ALTER TABLE contract_value_cache
  ADD COLUMN opensea_name TEXT,
  ADD COLUMN opensea_description TEXT,
  ADD COLUMN opensea_image_url TEXT,
  ADD COLUMN opensea_floor_price DOUBLE PRECISION,
  ADD COLUMN opensea_floor_price_symbol TEXT,
  ADD COLUMN opensea_resolved_at TIMESTAMPTZ;
