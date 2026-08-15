ALTER TABLE users DROP CONSTRAINT users_dashboard_theme_check;
ALTER TABLE users ADD CONSTRAINT users_dashboard_theme_check
  CHECK (dashboard_theme IN ('ghost-mint', 'ghost-mint-light', 'clean-vault', 'neon-arcade', 'quiet-ledger'));
