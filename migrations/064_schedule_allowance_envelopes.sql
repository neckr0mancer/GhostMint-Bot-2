-- Authoritative schedule allowance evidence. Historical rows remain `unknown`; only fresh,
-- server-verified on-chain evidence may become a hard cumulative reservation boundary.
ALTER TABLE mint_tasks
  ADD COLUMN allowance_scope TEXT NOT NULL DEFAULT 'unknown'
    CHECK (allowance_scope IN ('unknown','contract_cumulative','per_stage')),
  ADD COLUMN allowance_max_per_wallet NUMERIC(78,0)
    CHECK (allowance_max_per_wallet IS NULL OR allowance_max_per_wallet >= 0),
  ADD COLUMN allowance_minted_snapshot NUMERIC(78,0)
    CHECK (allowance_minted_snapshot IS NULL OR allowance_minted_snapshot >= 0),
  ADD COLUMN allowance_source TEXT,
  ADD COLUMN allowance_verified_at TIMESTAMPTZ,
  ADD COLUMN allowance_stage_start_at TIMESTAMPTZ;

CREATE INDEX mint_tasks_active_allowance_boundary_idx
  ON mint_tasks (
    user_id,
    LOWER(wallet_address),
    LOWER(chain),
    LOWER(contract_address),
    allowance_stage_start_at
  )
  WHERE status IN ('scheduled','claimed','retry','paused');
