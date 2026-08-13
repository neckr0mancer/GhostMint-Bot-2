ALTER TABLE activity ADD COLUMN trigger_source TEXT;
ALTER TABLE activity ADD COLUMN verification_state TEXT;

ALTER TABLE activity ADD CONSTRAINT activity_trigger_source_check
  CHECK (trigger_source IS NULL OR trigger_source IN ('manual','scheduled','blockchain-triggered','social-triggered'));
ALTER TABLE activity ADD CONSTRAINT activity_verification_state_check
  CHECK (verification_state IS NULL OR verification_state IN ('on','bypassed'));
