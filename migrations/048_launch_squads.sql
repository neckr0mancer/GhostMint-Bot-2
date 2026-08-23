-- Coordinated multi-wallet mint launches ("ACO" service): one squad = one contract on one chain,
-- fanned out across many wallets in waves. Complements scheduled tasks (single-wallet timed mints)
-- and snipers (reactive copies) -- this table is the durable state for planned bursts.
--
-- Deliberately NOT stored here: signed transactions. Pre-signing would put spendable payloads in
-- the database; v1 signs inside transactionEngine.submit at fire time like every other path.
CREATE TABLE launch_squads (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  -- Resolved at staging time so firing does no detection work: which calldata shape to use and
  -- what value to attach. For SeaDrop contracts these capture the live PublicDrop's price and the
  -- minter's fee recipient; for plain ERC-721 mints method_signature is whatever the operator chose.
  method_signature TEXT NOT NULL DEFAULT 'mint(uint256)',
  sea_drop_address TEXT,
  fee_recipient TEXT,
  price_wei NUMERIC,
  gas_price_wei NUMERIC,
  -- manual = armed squad waits for an explicit FIRE; timer = fires itself at fire_at.
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  fire_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'drafting',
  -- drafting -> staged -> (armed) -> firing -> done | aborted | failed
  wave_size INTEGER NOT NULL DEFAULT 25,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at TIMESTAMPTZ,
  report JSONB
);

CREATE TABLE launch_squad_members (
  squad_id UUID NOT NULL REFERENCES launch_squads(id) ON DELETE CASCADE,
  wallet_label TEXT NOT NULL,
  wave INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending -> staged -> sent -> confirmed | reverted | failed | skipped
  tx_hash TEXT,
  intent_id UUID,
  error TEXT,
  sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  PRIMARY KEY (squad_id, wallet_label)
);

CREATE INDEX idx_launch_squads_user ON launch_squads(user_id);
CREATE INDEX idx_launch_squads_status ON launch_squads(status);
