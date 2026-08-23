-- Launch-squad triggers beyond manual/timer: fire at a target block height, or on the first
-- pending transaction touching the mint contract (the front-running edge). NULL = not set.
ALTER TABLE launch_squads ADD COLUMN IF NOT EXISTS target_block BIGINT;
