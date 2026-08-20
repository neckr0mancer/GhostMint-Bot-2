-- Password-gating for sensitive actions taken from Telegram and Discord. The dashboard has had an
-- account password since migration 036 (security_password_hash); the bots had nothing at all, so
-- anyone holding an unlocked phone could remove a wallet or export a key from the chat.
--
-- Deliberately one column on users rather than a new table: this is a single per-account setting
-- with no history, and the password it verifies against already lives on this row.
--
-- 'off' is the default and the value every existing row gets. The feature ships switched off for
-- everyone and is turned on per account, by the account owner -- a gate that appeared on its own
-- would lock people out of their own wallets without warning.
--
--   off       -- no gate; current behaviour
--   sensitive -- irreversible or key-exposing: export key, remove wallet, send funds
--   strict    -- adds the read-only surfaces: wallet list, balances, activity
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_gate_level TEXT NOT NULL DEFAULT 'off';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bot_gate_level_check;
ALTER TABLE users ADD CONSTRAINT users_bot_gate_level_check
  CHECK (bot_gate_level IN ('off', 'sensitive', 'strict'));
