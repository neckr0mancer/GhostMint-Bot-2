-- src/dashboard/api.js already calls securityAudit.record({...outcome:'failure'...}) for failed
-- login/security-password attempts (auditLoginPassword/auditSecurityPassword), but every call is
-- wrapped in .catch(()=>{}) -- so these inserts have been silently failing this whole time, and
-- failed login/security-password attempts have never actually been logged. Widening the check
-- constraint fixes the writes; nothing before this migration can be recovered since the rows were
-- never inserted.
ALTER TABLE bot_security_audit DROP CONSTRAINT bot_security_audit_outcome_check;
ALTER TABLE bot_security_audit ADD CONSTRAINT bot_security_audit_outcome_check
  CHECK (outcome IN ('unauthorized','rate_limited','invalid_context','success','account_blocked','failure'));
