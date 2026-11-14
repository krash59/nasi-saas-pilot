-- 012: time-bounded break-glass with audit logs (BDD_F06_01, DIR §8.4 §9.1 §9.2, RACI ACT_08).
-- Two-person rule by database identity (session_user), not typed names:
--   R_OP_ENGINEER (member of nasi_break_glass) requests with a reason and duration (max 60 min);
--   R_OP_OWNER (member of nasi_break_glass_approver) approves under a DIFFERENT login; the clock starts then.
-- Only the requesting engineer may read, read-only, while the grant is live; every read is logged.
-- The customer sees the activity unless an emergency/legal exception is documented on the grant.
-- Grant and access rows are append-only for every app role; retention 365 days (RET_D03). Idempotent.

CREATE TABLE IF NOT EXISTS break_glass_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Audit outlives project purge (90 d) for the 365-day log period: keep the row, drop the link.
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  engineer TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  minutes INT NOT NULL CHECK (minutes BETWEEN 1 AND 60),
  notify_customer BOOLEAN NOT NULL DEFAULT true,
  notification_exception TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approver TEXT,
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CHECK (approver IS NULL OR approver <> engineer),
  CHECK ((approver IS NULL) = (approved_at IS NULL) AND (approved_at IS NULL) = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at = approved_at + make_interval(mins => minutes)),
  CHECK (notify_customer OR length(trim(coalesce(notification_exception, ''))) >= 10)
);
CREATE TABLE IF NOT EXISTS break_glass_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES break_glass_grants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('REQUESTED','APPROVED','CONTENT_READ','ACCESS_DENIED','CLOSED')),
  detail TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_break_glass_log_customer ON break_glass_access_log(customer_id, at);

ALTER TABLE break_glass_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE break_glass_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_access_log FORCE ROW LEVEL SECURITY;
-- Customers see break-glass activity on their own account (transparency + notification).
DROP POLICY IF EXISTS break_glass_grants_customer_read ON break_glass_grants;
CREATE POLICY break_glass_grants_customer_read ON break_glass_grants FOR SELECT
  USING (customer_id = app_current_customer_id() AND notify_customer);
DROP POLICY IF EXISTS break_glass_log_customer_read ON break_glass_access_log;
CREATE POLICY break_glass_log_customer_read ON break_glass_access_log FOR SELECT
  USING (customer_id = app_current_customer_id() AND grant_id IN (SELECT id FROM break_glass_grants));
-- Retention purge (365 days).
DROP POLICY IF EXISTS break_glass_log_purge ON break_glass_access_log;
CREATE POLICY break_glass_log_purge ON break_glass_access_log FOR DELETE TO nasi_retention_purge
  USING (customer_id = app_current_customer_id());
DROP POLICY IF EXISTS break_glass_grants_purge ON break_glass_grants;
CREATE POLICY break_glass_grants_purge ON break_glass_grants FOR DELETE TO nasi_retention_purge
  USING (customer_id = app_current_customer_id());
DROP POLICY IF EXISTS break_glass_grants_purge_read ON break_glass_grants;
CREATE POLICY break_glass_grants_purge_read ON break_glass_grants FOR SELECT TO nasi_retention_purge
  USING (customer_id = app_current_customer_id());

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_break_glass') THEN
    CREATE ROLE nasi_break_glass NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_break_glass_approver') THEN
    CREATE ROLE nasi_break_glass_approver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bg_log(g UUID, c UUID, a TEXT, d TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO break_glass_access_log(grant_id, customer_id, actor, action, detail) VALUES (g, c, session_user, a, d);
$$;

CREATE OR REPLACE FUNCTION break_glass_request(p_project UUID, p_reason TEXT, p_minutes INT,
  p_notify BOOLEAN DEFAULT true, p_exception TEXT DEFAULT NULL) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g UUID; c UUID;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_break_glass', 'MEMBER') THEN RAISE EXCEPTION 'NOT_BREAK_GLASS_ENGINEER'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  INSERT INTO break_glass_grants(customer_id, project_id, engineer, reason, minutes, notify_customer, notification_exception)
    VALUES (c, p_project, session_user, p_reason, p_minutes, p_notify, p_exception) RETURNING id INTO g;
  PERFORM bg_log(g, c, 'REQUESTED', format('%s min requested: %s', p_minutes, p_reason));
  RETURN g;
END $$;

CREATE OR REPLACE FUNCTION break_glass_approve(p_grant UUID) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_break_glass_approver', 'MEMBER') THEN RAISE EXCEPTION 'NOT_BREAK_GLASS_APPROVER'; END IF;
  SELECT * INTO r FROM break_glass_grants WHERE id = p_grant FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'GRANT_NOT_FOUND'; END IF;
  IF r.engineer = session_user THEN RAISE EXCEPTION 'APPROVER_MUST_DIFFER_FROM_ENGINEER'; END IF;
  IF r.approved_at IS NOT NULL OR r.closed_at IS NOT NULL THEN RAISE EXCEPTION 'GRANT_NOT_PENDING'; END IF;
  IF r.requested_at + interval '24 hours' <= now() THEN RAISE EXCEPTION 'REQUEST_STALE'; END IF;
  UPDATE break_glass_grants SET approver = session_user, approved_at = now(), expires_at = now() + make_interval(mins => r.minutes)
    WHERE id = p_grant RETURNING expires_at INTO r.expires_at;
  PERFORM bg_log(r.id, r.customer_id, 'APPROVED', format('approved until %s', r.expires_at));
  RETURN r.expires_at;
END $$;

-- Read-only content access by the requesting engineer under a live, approved grant. Every call is logged.
CREATE OR REPLACE FUNCTION break_glass_read(p_grant UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants; out JSONB;
BEGIN
  SELECT * INTO r FROM break_glass_grants WHERE id = p_grant;
  IF r.id IS NULL THEN RAISE EXCEPTION 'GRANT_NOT_FOUND'; END IF;
  IF r.engineer <> session_user OR r.approved_at IS NULL OR r.closed_at IS NOT NULL OR r.expires_at <= now() THEN
    PERFORM bg_log(r.id, r.customer_id, 'ACCESS_DENIED',
      CASE WHEN r.engineer <> session_user THEN 'not the grant holder' WHEN r.approved_at IS NULL THEN 'not approved'
           WHEN r.closed_at IS NOT NULL THEN 'grant closed' ELSE 'grant expired' END);
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object(
    'project', (SELECT jsonb_build_object('id', id, 'name', name, 'lifecycle_stage', lifecycle_stage) FROM projects WHERE id = r.project_id),
    'design_messages', COALESCE((SELECT jsonb_agg(jsonb_build_object('role', role, 'content', content, 'created_at', created_at) ORDER BY created_at)
                                 FROM design_messages WHERE project_id = r.project_id), '[]'::jsonb),
    'design_summary', (SELECT to_jsonb(s) - 'project_id' FROM design_summaries s WHERE project_id = r.project_id),
    'dir', (SELECT jsonb_build_object('status', status, 'content', content) FROM dir_drafts WHERE project_id = r.project_id)
  ) INTO out;
  PERFORM bg_log(r.id, r.customer_id, 'CONTENT_READ', format('project %s: messages, summary, DIR', r.project_id));
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION break_glass_close(p_grant UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants;
BEGIN
  SELECT * INTO r FROM break_glass_grants WHERE id = p_grant FOR UPDATE;
  IF r.id IS NULL OR r.closed_at IS NOT NULL OR session_user NOT IN (r.engineer, coalesce(r.approver, '')) THEN RETURN false; END IF;
  UPDATE break_glass_grants SET closed_at = now() WHERE id = p_grant;
  PERFORM bg_log(r.id, r.customer_id, 'CLOSED', 'closed early');
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION bg_log(UUID,UUID,TEXT,TEXT), break_glass_request(UUID,TEXT,INT,BOOLEAN,TEXT), break_glass_approve(UUID), break_glass_read(UUID), break_glass_close(UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nasi_break_glass;
GRANT USAGE ON SCHEMA public TO nasi_break_glass_approver;
GRANT EXECUTE ON FUNCTION break_glass_request(UUID,TEXT,INT,BOOLEAN,TEXT), break_glass_read(UUID), break_glass_close(UUID) TO nasi_break_glass;
GRANT EXECUTE ON FUNCTION break_glass_approve(UUID), break_glass_close(UUID) TO nasi_break_glass_approver;
GRANT SELECT, DELETE ON break_glass_grants, break_glass_access_log TO nasi_retention_purge;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION bg_log(UUID,UUID,TEXT,TEXT), break_glass_request(UUID,TEXT,INT,BOOLEAN,TEXT), break_glass_approve(UUID), break_glass_read(UUID), break_glass_close(UUID) FROM nasi_app_runtime;
    REVOKE ALL ON break_glass_grants, break_glass_access_log FROM nasi_app_runtime;
    GRANT SELECT ON break_glass_grants, break_glass_access_log TO nasi_app_runtime;
  END IF;
END $$;

-- Retention: break-glass logs follow the 365-day security audit period (RET_D03).
CREATE OR REPLACE FUNCTION retention_due_customers() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM customers c WHERE
       (c.offboard_requested_at IS NOT NULL AND c.offboard_requested_at + interval '30 days' <= now())
    OR EXISTS (SELECT 1 FROM projects p WHERE p.customer_id = c.id AND p.status = 'archived' AND p.archived_at + interval '90 days' <= now())
    OR EXISTS (SELECT 1 FROM security_audit_events e WHERE e.customer_id = c.id AND e.created_at + interval '365 days' <= now())
    OR EXISTS (SELECT 1 FROM usage_meter_events u WHERE u.customer_id = c.id AND u.occurred_at + interval '24 months' <= now())
    OR EXISTS (SELECT 1 FROM break_glass_access_log b WHERE b.customer_id = c.id AND b.at + interval '365 days' <= now());
$$;
REVOKE ALL ON FUNCTION retention_due_customers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_due_customers() TO nasi_retention_purge;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION retention_due_customers() FROM nasi_app_runtime;
  END IF;
END $$;
