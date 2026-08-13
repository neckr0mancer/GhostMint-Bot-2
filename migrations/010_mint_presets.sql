CREATE TABLE mint_presets (
  preset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  method_signature TEXT NOT NULL,
  abi_fragment JSONB NOT NULL,
  arguments JSONB NOT NULL,
  value_wei NUMERIC(78,0) NOT NULL CHECK (value_wei >= 0),
  proof_source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (name <> '' AND contract_address <> '' AND method_signature <> '')
);

CREATE UNIQUE INDEX mint_presets_user_name_ci_key ON mint_presets (user_id, LOWER(name));
CREATE INDEX mint_presets_user_contract_idx ON mint_presets (user_id, LOWER(contract_address));

ALTER TABLE transaction_intents ADD COLUMN method_signature TEXT;
ALTER TABLE transaction_intents ADD COLUMN call_preview JSONB;
