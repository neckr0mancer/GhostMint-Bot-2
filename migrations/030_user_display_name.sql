-- Optional display name so the dashboard can greet a user by something friendlier than a raw
-- platform ID. NULL means "never set" -- distinct from an empty string, so the frontend knows to
-- prompt for one, whether the account is brand new or just never got asked before this feature existed.
ALTER TABLE users ADD COLUMN display_name TEXT;
