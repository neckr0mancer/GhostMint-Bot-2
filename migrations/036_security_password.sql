-- A dashboard-only account password gating sensitive browser-side actions (currently: exporting a
-- wallet's keystore). Independent of the Telegram/Discord identity that authenticates the session
-- itself -- this is a second factor scoped to this one browser-facing risk category. NULL means the
-- user hasn't set one yet.
ALTER TABLE users ADD COLUMN security_password_hash TEXT;
