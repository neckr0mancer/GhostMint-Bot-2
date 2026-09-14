-- New schedules reserve one semantic stage per user+wallet+chain+contract. Historical rows keep a
-- NULL key so this migration never deletes, merges, or invalidates existing user tasks; the
-- transactional repository also compares their legacy stage columns before accepting a new row.
ALTER TABLE mint_tasks
  ADD COLUMN wallet_address TEXT,
  ADD COLUMN reservation_stage_key TEXT;

UPDATE mint_tasks task
SET wallet_address=wallet.address
FROM wallets wallet
WHERE task.wallet_address IS NULL
  AND wallet.user_id=task.user_id
  AND LOWER(wallet.label)=LOWER(task.wallet_label);

CREATE INDEX mint_tasks_active_reservation_lookup_idx
  ON mint_tasks (user_id,LOWER(wallet_address),LOWER(chain),LOWER(contract_address))
  WHERE status IN ('scheduled','claimed','retry','paused');

-- Only new canonical-key rows participate in the physical uniqueness rule. This makes concurrent
-- first-party inserts fail closed while preserving any historical duplicates for an explicit user
-- audit rather than silently choosing or cancelling one during deployment.
CREATE UNIQUE INDEX mint_tasks_active_wallet_contract_stage_uniq
  ON mint_tasks (user_id,LOWER(wallet_address),LOWER(chain),LOWER(contract_address),reservation_stage_key)
  WHERE wallet_address IS NOT NULL AND chain IS NOT NULL AND reservation_stage_key IS NOT NULL
    AND status IN ('scheduled','claimed','retry','paused');
