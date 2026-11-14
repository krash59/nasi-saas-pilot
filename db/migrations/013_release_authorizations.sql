-- 013: dual production authorization (BDD_F09_01..03, DIR §8.2.1 C14, RACI ACT_05A/ACT_05B).
-- ACT_05A Customer Release Authorization: the customer approves or rejects a specific release of their app.
-- ACT_05B Platform Production Authorization: an operator owner login (nasi_platform_release_approver)
--         approves or rejects the same release on platform production infrastructure.
-- A production deploy credential is issued ONLY to the deploy orchestrator (nasi_deploy_orchestrator),
-- only when the LATEST 05A and 05B decisions for that exact release are approvals and unexpired.
-- Either party blocks with a later rejection; missing/expired/rejected -> deny (fail closed).
-- Decisions are append-only; expiry 24 h (initial default, DIR gives no figure). Credential lives 15 min,
-- single use, stored only as a SHA-256 hash. Agents never reach these paths (middleware, BDD_F08_01). Idempotent.

CREATE TABLE IF NOT EXISTS customer_release_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL CHECK (release_ref ~ '^[A-Za-z0-9._-]{7,80}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by TEXT NOT NULL CHECK (length(trim(decided_by)) > 0),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_cra_release ON customer_release_authorizations(project_id, release_ref, decided_at);
ALTER TABLE customer_release_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_release_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cra_insert ON customer_release_authorizations;
DROP POLICY IF EXISTS cra_select ON customer_release_authorizations;
CREATE POLICY cra_insert ON customer_release_authorizations FOR INSERT
  WITH CHECK (customer_id = app_current_customer_id() AND project_id IN (SELECT id FROM projects WHERE customer_id = app_current_customer_id()));
CREATE POLICY cra_select ON customer_release_authorizations FOR SELECT USING (customer_id = app_current_customer_id());

CREATE TABLE IF NOT EXISTS platform_production_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL CHECK (release_ref ~ '^[A-Za-z0-9._-]{7,80}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_ppa_release ON platform_production_authorizations(project_id, release_ref, decided_at);
ALTER TABLE platform_production_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_production_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ppa_select ON platform_production_authorizations;
CREATE POLICY ppa_select ON platform_production_authorizations FOR SELECT USING (customer_id = app_current_customer_id());

CREATE TABLE IF NOT EXISTS production_deploy_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL,
  customer_authorization_id UUID NOT NULL REFERENCES customer_release_authorizations(id) ON DELETE CASCADE,
  platform_authorization_id UUID NOT NULL REFERENCES platform_production_authorizations(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  issued_to TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS production_deploy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ISSUED','DENIED','REDEEMED','REDEEM_DENIED')),
  reason TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE production_deploy_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_deploy_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE production_deploy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_deploy_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdd_select ON production_deploy_decisions;
CREATE POLICY pdd_select ON production_deploy_decisions FOR SELECT USING (customer_id = app_current_customer_id());

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_platform_release_approver') THEN
    CREATE ROLE nasi_platform_release_approver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_deploy_orchestrator') THEN
    CREATE ROLE nasi_deploy_orchestrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ACT_05B: operator owner records approve/reject for one exact release.
CREATE OR REPLACE FUNCTION record_platform_production_authorization(p_project UUID, p_release TEXT, p_decision TEXT, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; v_id UUID;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_platform_release_approver', 'MEMBER') THEN RAISE EXCEPTION 'NOT_PLATFORM_RELEASE_APPROVER'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  INSERT INTO platform_production_authorizations(project_id, customer_id, release_ref, decision, decided_by, reason)
    VALUES (p_project, c, p_release, p_decision, session_user, p_reason) RETURNING platform_production_authorizations.id INTO v_id;
  RETURN v_id;
END $$;

-- Deploy orchestrator asks for a production credential. Returns {token} or {denied}. Every request is logged.
CREATE OR REPLACE FUNCTION issue_production_deploy_credential(p_project UUID, p_release TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; a customer_release_authorizations; b platform_production_authorizations; tok TEXT; why TEXT;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_deploy_orchestrator', 'MEMBER') THEN RAISE EXCEPTION 'NOT_DEPLOY_ORCHESTRATOR'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('deploy:' || p_project || ':' || p_release));
  SELECT * INTO a FROM customer_release_authorizations WHERE project_id = p_project AND release_ref = p_release ORDER BY decided_at DESC, id DESC LIMIT 1;
  SELECT * INTO b FROM platform_production_authorizations WHERE project_id = p_project AND release_ref = p_release ORDER BY decided_at DESC, id DESC LIMIT 1;
  why := CASE
    WHEN a.id IS NULL THEN 'CUSTOMER_RELEASE_AUTHORIZATION_MISSING'
    WHEN a.decision <> 'approved' THEN 'CUSTOMER_RELEASE_REJECTED'
    WHEN a.expires_at <= now() THEN 'CUSTOMER_RELEASE_AUTHORIZATION_EXPIRED'
    WHEN b.id IS NULL THEN 'PLATFORM_PRODUCTION_AUTHORIZATION_MISSING'
    WHEN b.decision <> 'approved' THEN 'PLATFORM_PRODUCTION_REJECTED'
    WHEN b.expires_at <= now() THEN 'PLATFORM_PRODUCTION_AUTHORIZATION_EXPIRED'
    -- BDD_F10_02 cap: production deploys / project / month = 3 (DIR 10.3; same value as lib/usage/meters.ts BETA_CAPS).
    WHEN (SELECT COALESCE(sum(quantity), 0) FROM usage_meter_events WHERE project_id = p_project AND meter = 'production_deploys'
          AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') >= 3 THEN 'PRODUCTION_DEPLOY_CAP_REACHED'
    ELSE NULL END;
  IF why IS NOT NULL THEN
    INSERT INTO production_deploy_decisions(project_id, customer_id, release_ref, requested_by, outcome, reason) VALUES (p_project, c, p_release, session_user, 'DENIED', why);
    RETURN jsonb_build_object('denied', why);
  END IF;
  tok := 'nasi_deploy_' || encode(gen_random_bytes(32), 'hex');
  INSERT INTO production_deploy_credentials(project_id, customer_id, release_ref, customer_authorization_id, platform_authorization_id, token_sha256, issued_to)
    VALUES (p_project, c, p_release, a.id, b.id, encode(digest(tok, 'sha256'), 'hex'), session_user);
  INSERT INTO production_deploy_decisions(project_id, customer_id, release_ref, requested_by, outcome, reason)
    VALUES (p_project, c, p_release, session_user, 'ISSUED', format('ACT_05A %s + ACT_05B %s', a.id, b.id));
  RETURN jsonb_build_object('token', tok, 'expires_at', now() + interval '15 minutes');
END $$;

-- The deploy step redeems the credential once; it re-checks both approvals at redemption time.
CREATE OR REPLACE FUNCTION redeem_production_deploy_credential(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k production_deploy_credentials; still JSONB; a customer_release_authorizations; b platform_production_authorizations; why TEXT;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_deploy_orchestrator', 'MEMBER') THEN RAISE EXCEPTION 'NOT_DEPLOY_ORCHESTRATOR'; END IF;
  SELECT * INTO k FROM production_deploy_credentials WHERE token_sha256 = encode(digest(p_token, 'sha256'), 'hex') FOR UPDATE;
  IF k.id IS NULL THEN RETURN jsonb_build_object('denied', 'CREDENTIAL_UNKNOWN'); END IF;
  SELECT * INTO a FROM customer_release_authorizations WHERE project_id = k.project_id AND release_ref = k.release_ref ORDER BY decided_at DESC, id DESC LIMIT 1;
  SELECT * INTO b FROM platform_production_authorizations WHERE project_id = k.project_id AND release_ref = k.release_ref ORDER BY decided_at DESC, id DESC LIMIT 1;
  why := CASE
    WHEN k.used_at IS NOT NULL THEN 'CREDENTIAL_ALREADY_USED'
    WHEN k.expires_at <= now() THEN 'CREDENTIAL_EXPIRED'
    WHEN a.decision <> 'approved' OR a.expires_at <= now() THEN 'CUSTOMER_RELEASE_NO_LONGER_VALID'
    WHEN b.decision <> 'approved' OR b.expires_at <= now() THEN 'PLATFORM_PRODUCTION_NO_LONGER_VALID'
    ELSE NULL END;
  IF why IS NOT NULL THEN
    INSERT INTO production_deploy_decisions(project_id, customer_id, release_ref, requested_by, outcome, reason) VALUES (k.project_id, k.customer_id, k.release_ref, session_user, 'REDEEM_DENIED', why);
    RETURN jsonb_build_object('denied', why);
  END IF;
  UPDATE production_deploy_credentials SET used_at = now() WHERE id = k.id;
  INSERT INTO usage_meter_events(customer_id, project_id, meter, quantity, source) VALUES (k.customer_id, k.project_id, 'production_deploys', 1, 'deploy_orchestrator');
  INSERT INTO production_deploy_decisions(project_id, customer_id, release_ref, requested_by, outcome, reason) VALUES (k.project_id, k.customer_id, k.release_ref, session_user, 'REDEEMED', 'deploy may proceed');
  RETURN jsonb_build_object('project_id', k.project_id, 'release_ref', k.release_ref, 'deploy', 'AUTHORIZED');
END $$;

REVOKE ALL ON FUNCTION record_platform_production_authorization(UUID,TEXT,TEXT,TEXT), issue_production_deploy_credential(UUID,TEXT), redeem_production_deploy_credential(TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nasi_platform_release_approver, nasi_deploy_orchestrator;
GRANT EXECUTE ON FUNCTION record_platform_production_authorization(UUID,TEXT,TEXT,TEXT) TO nasi_platform_release_approver;
GRANT EXECUTE ON FUNCTION issue_production_deploy_credential(UUID,TEXT), redeem_production_deploy_credential(TEXT) TO nasi_deploy_orchestrator;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION record_platform_production_authorization(UUID,TEXT,TEXT,TEXT), issue_production_deploy_credential(UUID,TEXT), redeem_production_deploy_credential(TEXT) FROM nasi_app_runtime;
    REVOKE ALL ON customer_release_authorizations, platform_production_authorizations, production_deploy_credentials, production_deploy_decisions FROM nasi_app_runtime;
    GRANT SELECT, INSERT ON customer_release_authorizations TO nasi_app_runtime;
    GRANT SELECT ON platform_production_authorizations, production_deploy_decisions TO nasi_app_runtime;
  END IF;
END $$;
