-- A merge re-parents owned parent rows to an already-existing retained user. These composite
-- ownership foreign keys must carry that owner change to their children; their existing delete
-- behavior remains unchanged. This migration enables only referential integrity and does not
-- enable or perform an account merge.

LOCK TABLE launch_squads IN ACCESS EXCLUSIVE MODE;

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM launch_squads
    WHERE user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'launch_squads contains a non-UUID user_id; refusing ownership migration'
      USING ERRCODE = '23514';
  END IF;
END
$block$;

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM launch_squads squad
    LEFT JOIN users owner ON owner.user_id = squad.user_id::UUID
    WHERE owner.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'launch_squads contains an orphan user_id; refusing ownership migration'
      USING ERRCODE = '23503';
  END IF;
END
$block$;

ALTER TABLE launch_squads
  ALTER COLUMN user_id TYPE UUID USING user_id::UUID;

ALTER TABLE launch_squads
  ADD CONSTRAINT launch_squads_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE sniper_event_transitions
  ADD CONSTRAINT sniper_event_transitions_owner_merge_fkey
  FOREIGN KEY (user_id, sniper_id, tx_hash)
  REFERENCES sniper_seen_transactions(user_id, sniper_id, tx_hash)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE sniper_event_transitions
  VALIDATE CONSTRAINT sniper_event_transitions_owner_merge_fkey;
ALTER TABLE sniper_event_transitions
  DROP CONSTRAINT sniper_event_transitions_user_id_sniper_id_tx_hash_fkey;
ALTER TABLE sniper_event_transitions
  RENAME CONSTRAINT sniper_event_transitions_owner_merge_fkey
  TO sniper_event_transitions_user_id_sniper_id_tx_hash_fkey;

ALTER TABLE sniper_seen_transactions
  ADD CONSTRAINT sniper_seen_transactions_owner_merge_fkey
  FOREIGN KEY (user_id, sniper_id)
  REFERENCES snipers(user_id, id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE sniper_seen_transactions
  VALIDATE CONSTRAINT sniper_seen_transactions_owner_merge_fkey;
ALTER TABLE sniper_seen_transactions
  DROP CONSTRAINT sniper_seen_transactions_owner_fkey;
ALTER TABLE sniper_seen_transactions
  RENAME CONSTRAINT sniper_seen_transactions_owner_merge_fkey
  TO sniper_seen_transactions_owner_fkey;

ALTER TABLE mint_task_attempts
  ADD CONSTRAINT mint_task_attempts_owner_merge_fkey
  FOREIGN KEY (user_id, task_id)
  REFERENCES mint_tasks(user_id, id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE mint_task_attempts
  VALIDATE CONSTRAINT mint_task_attempts_owner_merge_fkey;
ALTER TABLE mint_task_attempts
  DROP CONSTRAINT mint_task_attempts_user_id_task_id_fkey;
ALTER TABLE mint_task_attempts
  RENAME CONSTRAINT mint_task_attempts_owner_merge_fkey
  TO mint_task_attempts_user_id_task_id_fkey;

ALTER TABLE mint_task_preflight_checks
  ADD CONSTRAINT mint_task_preflight_checks_owner_merge_fkey
  FOREIGN KEY (user_id, task_id)
  REFERENCES mint_tasks(user_id, id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE mint_task_preflight_checks
  VALIDATE CONSTRAINT mint_task_preflight_checks_owner_merge_fkey;
ALTER TABLE mint_task_preflight_checks
  DROP CONSTRAINT mint_task_preflight_checks_user_id_task_id_fkey;
ALTER TABLE mint_task_preflight_checks
  RENAME CONSTRAINT mint_task_preflight_checks_owner_merge_fkey
  TO mint_task_preflight_checks_user_id_task_id_fkey;

ALTER TABLE mint_task_change_events
  ADD CONSTRAINT mint_task_change_events_owner_merge_fkey
  FOREIGN KEY (user_id, task_id)
  REFERENCES mint_tasks(user_id, id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE mint_task_change_events
  VALIDATE CONSTRAINT mint_task_change_events_owner_merge_fkey;
ALTER TABLE mint_task_change_events
  DROP CONSTRAINT mint_task_change_events_user_id_task_id_fkey;
ALTER TABLE mint_task_change_events
  RENAME CONSTRAINT mint_task_change_events_owner_merge_fkey
  TO mint_task_change_events_user_id_task_id_fkey;

ALTER TABLE live_acceptance_runs
  ADD CONSTRAINT live_acceptance_runs_wallet_owner_merge_fkey
  FOREIGN KEY (operator_user_id, wallet_id)
  REFERENCES wallets(user_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE live_acceptance_runs
  VALIDATE CONSTRAINT live_acceptance_runs_wallet_owner_merge_fkey;
ALTER TABLE live_acceptance_runs
  DROP CONSTRAINT live_acceptance_runs_wallet_fkey;
ALTER TABLE live_acceptance_runs
  RENAME CONSTRAINT live_acceptance_runs_wallet_owner_merge_fkey
  TO live_acceptance_runs_wallet_fkey;

ALTER TABLE opensea_wallet_eligibility_authorizations
  ADD CONSTRAINT opensea_wallet_eligibility_wallet_owner_merge_fkey
  FOREIGN KEY (user_id, wallet_id)
  REFERENCES wallets(user_id, id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE opensea_wallet_eligibility_authorizations
  VALIDATE CONSTRAINT opensea_wallet_eligibility_wallet_owner_merge_fkey;
ALTER TABLE opensea_wallet_eligibility_authorizations
  DROP CONSTRAINT opensea_wallet_eligibility_wallet_owner_fk;
ALTER TABLE opensea_wallet_eligibility_authorizations
  RENAME CONSTRAINT opensea_wallet_eligibility_wallet_owner_merge_fkey
  TO opensea_wallet_eligibility_wallet_owner_fk;
