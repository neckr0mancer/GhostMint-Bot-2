-- Scheduled mints must execute on the chain where the contract was detected, not the wallet's
-- nominal/default chain. Existing rows inherit their wallet's stored chain for compatibility;
-- all newly-created tasks persist the explicitly validated chain.
ALTER TABLE mint_tasks ADD COLUMN IF NOT EXISTS chain TEXT;

UPDATE mint_tasks task
SET chain = wallet.chain
FROM wallets wallet
WHERE task.chain IS NULL
  AND wallet.user_id = task.user_id
  AND wallet.label = task.wallet_label;

CREATE INDEX IF NOT EXISTS mint_tasks_user_chain_idx ON mint_tasks (user_id, chain);
