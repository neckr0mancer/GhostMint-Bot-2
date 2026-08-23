-- Records which OpenSea stage type ("public_sale", "allowlist", "gtd", "fcfs", ...) a scheduled
-- task was created against, so the scheduler can decide at execution time whether an OpenSea
-- outage/untracked-contract can fall back to this app's own on-chain calldata (public stages)
-- or must fail honestly because only OpenSea can prove eligibility (allowlist/GTD/FCFS).
ALTER TABLE mint_tasks ADD COLUMN IF NOT EXISTS stage_type TEXT;
