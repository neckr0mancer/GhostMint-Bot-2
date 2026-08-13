ALTER TABLE bot_security_audit DROP CONSTRAINT bot_security_audit_platform_check;
ALTER TABLE bot_security_audit ADD CONSTRAINT bot_security_audit_platform_check
  CHECK (platform IN ('telegram','discord','dashboard'));

ALTER TABLE bot_security_audit DROP CONSTRAINT bot_security_audit_outcome_check;
ALTER TABLE bot_security_audit ADD CONSTRAINT bot_security_audit_outcome_check
  CHECK (outcome IN ('unauthorized','rate_limited','invalid_context','success'));
