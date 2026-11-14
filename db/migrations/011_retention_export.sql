-- 011: export window, project archive, and tenant-scoped retention purge
-- (BDD_F11_01 / BDD_F11_02, DIR §9.2, DATA_RETENTION_POLICY_DRAFT.snl RET_D01..D06). Idempotent.
-- Periods (initial design defaults, legal validation pending): archived project data 90 days,
-- security audit 365 days, usage metering 24 months, export window after offboarding 30 days.
-- RET_D04 (auth events) is held by Clerk; the app stores none.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS offboard_requested_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_archived_at_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_archived_at_check
      CHECK ((status = 'archived') = (archived_at IS NOT NULL));
  END IF;
END $$;

ALTER TABLE security_audit_events DROP CONSTRAINT IF EXISTS security_audit_events_event_type_check;
ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_events_event_type_check
  CHECK (event_type IN ('PROJECT_ACCESS_DENIED','DATA_EXPORTED','OFFBOARDING_REQUESTED','PROJECT_ARCHIVED'));

-- Export allowed while active and for 30 days after offboarding was requested.
CREATE OR REPLACE FUNCTION customer_export_window_open() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT offboard_requested_at IS NULL OR now() < offboard_requested_at + interval '30 days'
                   FROM customers WHERE id = app_current_customer_id()), false);
$$;

-- The current tenant starts offboarding (first request wins; repeat calls keep the original date).
CREATE OR REPLACE FUNCTION request_offboarding() RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v TIMESTAMPTZ;
BEGIN
  IF app_current_customer_id() IS NULL THEN RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED'; END IF;
  UPDATE customers SET offboard_requested_at = COALESCE(offboard_requested_at, now())
    WHERE id = app_current_customer_id() RETURNING offboard_requested_at INTO v;
  RETURN v;
END $$;

-- Purge job: which tenants have anything past retention (ids only, no content).
CREATE OR REPLACE FUNCTION retention_due_customers() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM customers c WHERE
       (c.offboard_requested_at IS NOT NULL AND c.offboard_requested_at + interval '30 days' <= now())
    OR EXISTS (SELECT 1 FROM projects p WHERE p.customer_id = c.id AND p.status = 'archived' AND p.archived_at + interval '90 days' <= now())
    OR EXISTS (SELECT 1 FROM security_audit_events e WHERE e.customer_id = c.id AND e.created_at + interval '365 days' <= now())
    OR EXISTS (SELECT 1 FROM usage_meter_events u WHERE u.customer_id = c.id AND u.occurred_at + interval '24 months' <= now());
$$;

-- Erase the CURRENT tenant only, and only once its export window has closed.
CREATE OR REPLACE FUNCTION erase_customer_if_window_closed() RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid UUID := app_current_customer_id();
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = cid AND offboard_requested_at IS NOT NULL
                 AND offboard_requested_at + interval '30 days' <= now()) THEN RETURN false; END IF;
  DELETE FROM projects WHERE customer_id = cid;   -- cascades project content
  DELETE FROM customers WHERE id = cid;           -- cascades billing, audit, usage
  RETURN true;
END $$;

-- Purge run log: survives erasure (customer id only, no content).
CREATE TABLE IF NOT EXISTS retention_purge_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts JSONB NOT NULL
);
ALTER TABLE retention_purge_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_purge_runs FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_retention_purge') THEN
    CREATE ROLE nasi_retention_purge NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO nasi_retention_purge;
GRANT SELECT, DELETE ON projects, security_audit_events, usage_meter_events TO nasi_retention_purge;
GRANT SELECT, INSERT ON retention_purge_runs TO nasi_retention_purge;
GRANT EXECUTE ON FUNCTION app_current_customer_id() TO nasi_retention_purge;

DROP POLICY IF EXISTS security_audit_events_purge ON security_audit_events;
CREATE POLICY security_audit_events_purge ON security_audit_events FOR DELETE TO nasi_retention_purge
  USING (customer_id = app_current_customer_id());
DROP POLICY IF EXISTS usage_meter_events_purge ON usage_meter_events;
CREATE POLICY usage_meter_events_purge ON usage_meter_events FOR DELETE TO nasi_retention_purge
  USING (customer_id = app_current_customer_id());
DROP POLICY IF EXISTS retention_purge_runs_purge ON retention_purge_runs;
CREATE POLICY retention_purge_runs_purge ON retention_purge_runs FOR ALL TO nasi_retention_purge
  USING (customer_id = app_current_customer_id()) WITH CHECK (customer_id = app_current_customer_id());

-- Function privileges: definer functions are never PUBLIC.
REVOKE ALL ON FUNCTION customer_export_window_open(), request_offboarding(),
  retention_due_customers(), erase_customer_if_window_closed() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    GRANT EXECUTE ON FUNCTION customer_export_window_open(), request_offboarding() TO nasi_app_runtime;
    REVOKE EXECUTE ON FUNCTION retention_due_customers(), erase_customer_if_window_closed() FROM nasi_app_runtime;
    REVOKE ALL ON retention_purge_runs FROM nasi_app_runtime;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION retention_due_customers(), erase_customer_if_window_closed() TO nasi_retention_purge;
