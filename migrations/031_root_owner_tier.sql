-- A second, higher tier of ownership on top of the existing `is_owner` flag: root owners (capped at
-- 2 in application logic) are the only ones who can grant or revoke the regular owner title, and the
-- only ones who can act on an existing owner (ban/suspend/deactivate) at all. Both currently-existing
-- owners are promoted to root here -- there is no signal to prefer one over the other, and neither
-- should lose access they already have.
ALTER TABLE users ADD COLUMN is_root_owner BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET is_root_owner = TRUE WHERE is_owner = TRUE;
