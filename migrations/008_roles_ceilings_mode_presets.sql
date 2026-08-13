ALTER TABLE users ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE seat_groups (
  group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  max_transaction_value_wei NUMERIC(78,0) NOT NULL CHECK (max_transaction_value_wei >= 0),
  daily_spending_budget_wei NUMERIC(78,0) NOT NULL CHECK (daily_spending_budget_wei >= 0),
  gas_ceiling_gwei NUMERIC NOT NULL CHECK (gas_ceiling_gwei >= 0),
  simulation_forced BOOLEAN,
  created_by UUID NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX seat_groups_name_ci_key ON seat_groups (LOWER(name));

CREATE TABLE mode_presets (
  preset_key TEXT PRIMARY KEY CHECK (preset_key IN ('ultra_fast','fast','semi_safe','safe')),
  display_name TEXT NOT NULL,
  simulation_mode TEXT NOT NULL CHECK (simulation_mode IN ('off','on','blockchain_off')),
  confirmation_count INTEGER NOT NULL CHECK (confirmation_count BETWEEN 1 AND 1000),
  human_verification TEXT NOT NULL CHECK (human_verification IN ('on','bypass')),
  updated_by UUID REFERENCES users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO mode_presets (preset_key,display_name,simulation_mode,confirmation_count,human_verification) VALUES
  ('ultra_fast','Ultra Fast','off',1,'bypass'),
  ('fast','Fast','blockchain_off',3,'on'),
  ('semi_safe','Semi-Safe','on',12,'on'),
  ('safe','Safe','on',128,'on');

CREATE TABLE user_governance (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  group_id UUID REFERENCES seat_groups(group_id) ON DELETE SET NULL,
  max_transaction_value_wei NUMERIC(78,0) CHECK (max_transaction_value_wei IS NULL OR max_transaction_value_wei >= 0),
  daily_spending_budget_wei NUMERIC(78,0) CHECK (daily_spending_budget_wei IS NULL OR daily_spending_budget_wei >= 0),
  gas_ceiling_gwei NUMERIC CHECK (gas_ceiling_gwei IS NULL OR gas_ceiling_gwei >= 0),
  simulation_forced BOOLEAN,
  selected_preset_key TEXT REFERENCES mode_presets(preset_key),
  updated_by UUID REFERENCES users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_governance_group_idx ON user_governance (group_id);
CREATE INDEX users_owner_idx ON users (is_owner) WHERE is_owner=TRUE;
