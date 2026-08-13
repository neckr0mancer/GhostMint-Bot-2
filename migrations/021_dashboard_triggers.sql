ALTER TABLE trigger_execution_requests DROP CONSTRAINT trigger_execution_requests_status_check;
ALTER TABLE trigger_execution_requests ADD CONSTRAINT trigger_execution_requests_status_check
  CHECK (status IN ('pending','executing','executed','failed','expired','rejected'));
