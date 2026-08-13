ALTER TABLE mint_tasks ADD COLUMN new_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE mint_tasks DROP CONSTRAINT mint_tasks_pkey;
ALTER TABLE mint_tasks DROP COLUMN id;
ALTER TABLE mint_tasks RENAME COLUMN new_id TO id;
ALTER TABLE mint_tasks ADD PRIMARY KEY (user_id, id);

ALTER TABLE snipers ADD COLUMN new_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sniper_seen_transactions ADD COLUMN new_sniper_id UUID;

UPDATE sniper_seen_transactions seen
SET new_sniper_id = sniper.new_id
FROM snipers sniper
WHERE sniper.user_id = seen.user_id AND sniper.id = seen.sniper_id;

ALTER TABLE sniper_seen_transactions ALTER COLUMN new_sniper_id SET NOT NULL;
ALTER TABLE sniper_seen_transactions DROP CONSTRAINT sniper_seen_transactions_owner_fkey;
ALTER TABLE sniper_seen_transactions DROP CONSTRAINT sniper_seen_transactions_pkey;
ALTER TABLE snipers DROP CONSTRAINT snipers_pkey;

ALTER TABLE sniper_seen_transactions DROP COLUMN sniper_id;
ALTER TABLE sniper_seen_transactions RENAME COLUMN new_sniper_id TO sniper_id;
ALTER TABLE snipers DROP COLUMN id;
ALTER TABLE snipers RENAME COLUMN new_id TO id;

ALTER TABLE snipers ADD PRIMARY KEY (user_id, id);
ALTER TABLE sniper_seen_transactions ADD PRIMARY KEY (user_id, sniper_id, tx_hash);
ALTER TABLE sniper_seen_transactions ADD CONSTRAINT sniper_seen_transactions_owner_fkey
  FOREIGN KEY (user_id, sniper_id) REFERENCES snipers(user_id, id) ON DELETE CASCADE;
