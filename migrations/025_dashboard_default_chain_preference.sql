ALTER TABLE users ADD COLUMN default_chain TEXT
  CHECK (default_chain IN ('ethereum', 'base', 'arbitrum', 'polygon'));
