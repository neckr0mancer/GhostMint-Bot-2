-- A chosen, unique handle enabling username+password dashboard login as an alternative to the
-- existing Telegram/Discord authentication-code flow. Independent of security_password_hash
-- (migration 035) so setting just a security password (to gate exports etc.) never forces picking
-- a username -- but username+password login requires both to be set. Always stored lowercase; the
-- plain UNIQUE constraint is sufficient case-insensitive uniqueness since every write and lookup
-- normalizes to lowercase first (see src/validation/domain.js).
ALTER TABLE users ADD COLUMN username TEXT UNIQUE;
