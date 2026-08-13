ALTER TABLE users ADD COLUMN dashboard_theme TEXT NOT NULL DEFAULT 'ghost-mint'
  CHECK (dashboard_theme IN ('ghost-mint', 'clean-vault', 'neon-arcade', 'quiet-ledger'));
