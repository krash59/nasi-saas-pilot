-- 008: security audit events (BDD_F05_01: cross-tenant denial is recorded).
-- Append-only from the app's point of view: the runtime role may INSERT and read its own rows,
-- never UPDATE or DELETE. Idempotent.
CREATE TABLE IF NOT EXISTS security_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('PROJECT_ACCESS_DENIED')),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_audit_events_customer ON security_audit_events(customer_id, created_at);

ALTER TABLE security_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_audit_events_insert ON security_audit_events;
DROP POLICY IF EXISTS security_audit_events_select ON security_audit_events;
CREATE POLICY security_audit_events_insert ON security_audit_events FOR INSERT
  WITH CHECK (customer_id = app_current_customer_id());
CREATE POLICY security_audit_events_select ON security_audit_events FOR SELECT
  USING (customer_id = app_current_customer_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    GRANT SELECT, INSERT ON security_audit_events TO nasi_app_runtime;
    REVOKE UPDATE, DELETE ON security_audit_events FROM nasi_app_runtime;
  END IF;
END $$;
