ALTER TABLE users
  ADD COLUMN IF NOT EXISTS time_format TEXT NOT NULL DEFAULT '24h';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_time_format_check;

ALTER TABLE users
  ADD CONSTRAINT users_time_format_check
  CHECK (time_format IN ('12h','24h'));
