ALTER TABLE dashboard_sessions
  ADD COLUMN revoked_reason TEXT,
  ADD COLUMN client_label TEXT;

CREATE INDEX dashboard_sessions_user_recent_active_idx
  ON dashboard_sessions (user_id, last_seen_at DESC, created_at DESC)
  WHERE revoked_at IS NULL;
