ALTER TABLE pnl_records ADD COLUMN record_uuid UUID DEFAULT gen_random_uuid();
UPDATE pnl_records SET record_uuid=gen_random_uuid() WHERE record_uuid IS NULL;
ALTER TABLE pnl_records ALTER COLUMN record_uuid SET NOT NULL;
ALTER TABLE pnl_records DROP CONSTRAINT pnl_records_pkey;
ALTER TABLE pnl_records DROP COLUMN id;
ALTER TABLE pnl_records RENAME COLUMN record_uuid TO id;
ALTER TABLE pnl_records ADD PRIMARY KEY (id);

ALTER TABLE transaction_intents
  ADD COLUMN gas_used NUMERIC(78,0),
  ADD COLUMN effective_gas_price_wei NUMERIC(78,0),
  ADD COLUMN actual_network_cost_wei NUMERIC(78,0);

ALTER TABLE activity ADD COLUMN actual_network_cost_wei NUMERIC(78,0);

ALTER TABLE mint_presets
  ADD COLUMN allowlist_check JSONB;

CREATE INDEX activity_user_occurred_idx ON activity (user_id, occurred_at DESC, id DESC);
CREATE INDEX transaction_intents_user_created_idx ON transaction_intents (user_id, created_at DESC, intent_id DESC);
