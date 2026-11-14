-- 014: verification packages before promote (BDD_F15_01, DIR §5.2) and agent fail-closed HALT (BDD_F08_02, DIR §7.2).
-- Agents (members of nasi_agent_runtime) may only: run a preflight before each step, record their compute minutes,
-- and submit verification packages. They never get table access. Every agent step must present an active,
-- unrevoked implementation consent whose DIR digest still matches the approved DIR (missing proof -> HALT).
-- Triggers (DIR §7.2): missing authorization, cross-tenant access, usage cap, verification fail, injection suspicion.
-- Cross-tenant and injection halts are STICKY: the project stays halted until an operator in
-- nasi_agent_halt_reviewer clears it with a reason. The others stop only the step that tripped them.
-- Promote: staging (orchestrator) and the production credential (013, replaced below) both require the LATEST
-- verification package for that exact release to have passed. A later failing package blocks again. Idempotent.

-- ---------- event types ----------
ALTER TABLE security_audit_events DROP CONSTRAINT IF EXISTS security_audit_events_event_type_check;
ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_events_event_type_check
  CHECK (event_type IN ('PROJECT_ACCESS_DENIED','DATA_EXPORTED','OFFBOARDING_REQUESTED','PROJECT_ARCHIVED',
                        'AGENT_CROSS_TENANT_DENIED','AGENT_INJECTION_SUSPECTED'));

-- ---------- tables ----------
CREATE TABLE IF NOT EXISTS verification_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL CHECK (release_ref ~ '^[A-Za-z0-9._-]{7,80}$'),
  consent_id UUID REFERENCES implementation_consents(id) ON DELETE SET NULL,
  checks JSONB NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) > 0),
  passed BOOLEAN NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_release ON verification_packages(project_id, release_ref, submitted_at);

CREATE TABLE IF NOT EXISTS agent_halts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('MISSING_AUTHORIZATION','HITL_ACTION_ATTEMPTED','CROSS_TENANT_ACCESS',
                                           'USAGE_CAP_EXCEEDED','VERIFICATION_FAILED','INJECTION_SUSPECTED')),
  sticky BOOLEAN NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  raised_by TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_by TEXT,
  cleared_at TIMESTAMPTZ,
  clear_reason TEXT,
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL) AND (cleared_at IS NULL) = (clear_reason IS NULL)),
  CHECK (cleared_at IS NULL OR sticky)
);
CREATE INDEX IF NOT EXISTS idx_agent_halts_open ON agent_halts(project_id) WHERE sticky AND cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS staging_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  release_ref TEXT NOT NULL,
  package_id UUID REFERENCES verification_packages(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('PROMOTED','DENIED')),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['verification_packages','agent_halts','staging_promotions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (customer_id = app_current_customer_id())', t || '_select', t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_agent_runtime') THEN
    CREATE ROLE nasi_agent_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_agent_halt_reviewer') THEN
    CREATE ROLE nasi_agent_halt_reviewer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION agent_raise_halt(p_project UUID, p_trigger TEXT, p_action TEXT, p_detail TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; s BOOLEAN := p_trigger IN ('CROSS_TENANT_ACCESS','INJECTION_SUSPECTED'); v UUID;
BEGIN
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  INSERT INTO agent_halts(project_id, customer_id, trigger, sticky, action, detail, raised_by)
    VALUES (p_project, c, p_trigger, s, left(coalesce(p_action, '?'), 80), left(p_detail, 500), session_user) RETURNING id INTO v;
  IF p_trigger = 'INJECTION_SUSPECTED' THEN
    INSERT INTO security_audit_events(customer_id, event_type, resource_type, resource_id) VALUES (c, 'AGENT_INJECTION_SUSPECTED', 'project', p_project::text);
  END IF;
  RETURN jsonb_build_object('halt', p_trigger, 'halt_id', v, 'requires_operator_review', s);
END $$;

-- Heuristic prompt-injection / tool-abuse screen (OWASP LLM01/LLM06). Pattern match, not a classifier.
CREATE OR REPLACE FUNCTION agent_input_suspicious(p_input TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT pat FROM unnest(ARRAY[
    '(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system)\s+(instructions|rules|prompts?)',
    '(reveal|print|show|dump|leak|send)\s+.{0,40}(system\s+prompt|secret|api[_ ]?key|password|credential|token|env)',
    'you\s+are\s+now\s+(in\s+)?(developer|admin|dan|jailbreak|unrestricted)',
    'BEGIN\s+(RSA\s+|OPENSSH\s+)?PRIVATE\s+KEY', 'sk_live_[A-Za-z0-9]', '\mexfiltrat',
    '(curl|wget)\s+[^|;]*\|\s*(ba|z)?sh', '\mdrop\s+(table|schema|database)\M', 'rm\s+-rf\s+/',
    'set\s+(local\s+)?role\s', 'app\.current_customer_id', 'approve\s+(the\s+)?(release|deploy|dir|summary)\s+(yourself|automatically|on\s+behalf)'
  ]) AS pat WHERE coalesce(p_input, '') ~* pat LIMIT 1
$$;

-- Same digest check as lib/design/implementation-consent.ts getImplementationConsent.
CREATE OR REPLACE FUNCTION agent_consent_valid(p_project UUID, p_consent UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM implementation_consents c JOIN dir_drafts d ON d.project_id = c.project_id
    WHERE c.id = p_consent AND c.project_id = p_project AND c.customer_id = d.customer_id
      AND d.status = 'approved' AND d.approved_at IS NOT NULL AND c.approved_by = d.approved_by
      AND c.dir_sha256 = encode(digest(d.content::text, 'sha256'), 'hex')
      AND c.revoked_at IS NULL AND c.expires_at > now())
$$;

CREATE OR REPLACE FUNCTION agent_minutes_used(p_project UUID) RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(quantity), 0) FROM usage_meter_events WHERE project_id = p_project AND meter = 'agent_minutes'
    AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$;

-- ---------- agent preflight: called before EVERY agent step ----------
-- Allowlist = DIR §7.2 "may auto-run". Anything else is HITL-only and halts.
CREATE OR REPLACE FUNCTION agent_preflight(p_project UUID, p_consent UUID, p_action TEXT, p_target_project UUID DEFAULT NULL, p_input TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; tc UUID; open_halt agent_halts; pat TEXT;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_agent_runtime', 'MEMBER') THEN RAISE EXCEPTION 'NOT_AGENT_RUNTIME'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('agent:' || p_project));
  SELECT * INTO open_halt FROM agent_halts WHERE project_id = p_project AND sticky AND cleared_at IS NULL ORDER BY raised_at LIMIT 1;
  IF open_halt.id IS NOT NULL THEN
    RETURN jsonb_build_object('halt', 'HALTED_PENDING_OPERATOR_REVIEW', 'halt_id', open_halt.id, 'requires_operator_review', true);
  END IF;
  IF p_target_project IS NOT NULL AND p_target_project <> p_project THEN
    SELECT customer_id INTO tc FROM projects WHERE id = p_target_project;
    IF tc IS DISTINCT FROM c THEN
      INSERT INTO security_audit_events(customer_id, event_type, resource_type, resource_id) VALUES (c, 'AGENT_CROSS_TENANT_DENIED', 'project', p_target_project::text);
      IF tc IS NOT NULL THEN
        INSERT INTO security_audit_events(customer_id, event_type, resource_type, resource_id) VALUES (tc, 'AGENT_CROSS_TENANT_DENIED', 'project', p_target_project::text);
      END IF;
      RETURN agent_raise_halt(p_project, 'CROSS_TENANT_ACCESS', p_action, 'target project belongs to another tenant');
    END IF;
  END IF;
  pat := agent_input_suspicious(p_input);
  IF pat IS NOT NULL THEN RETURN agent_raise_halt(p_project, 'INJECTION_SUSPECTED', p_action, 'input matched pattern: ' || pat); END IF;
  IF p_consent IS NULL OR NOT agent_consent_valid(p_project, p_consent) THEN
    RETURN agent_raise_halt(p_project, 'MISSING_AUTHORIZATION', p_action, 'no active implementation consent for this project and approved DIR');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('read_artifacts','generate_draft','run_tests','produce_verification_package','agent_compute') THEN
    RETURN agent_raise_halt(p_project, 'HITL_ACTION_ATTEMPTED', p_action, 'action is not on the auto-run allowlist (DIR 7.2); a human must do it');
  END IF;
  -- BDD_F10_02: agent minutes / project / month = 180 (DIR 10.3; same value as lib/usage/meters.ts BETA_CAPS).
  IF agent_minutes_used(p_project) >= 180 THEN
    RETURN agent_raise_halt(p_project, 'USAGE_CAP_EXCEEDED', p_action, 'agent_minutes cap 180 reached this month');
  END IF;
  RETURN jsonb_build_object('proceed', true, 'agent_minutes_left', 180 - agent_minutes_used(p_project));
END $$;

-- Agent minutes producer: the runner reports compute time after each step; overshoot halts and is not recorded.
CREATE OR REPLACE FUNCTION agent_record_minutes(p_project UUID, p_consent UUID, p_minutes NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pre JSONB; c UUID;
BEGIN
  IF p_minutes IS NULL OR p_minutes <= 0 OR p_minutes > 180 THEN RAISE EXCEPTION 'INVALID_MINUTES'; END IF;
  pre := agent_preflight(p_project, p_consent, 'agent_compute');
  IF pre ? 'halt' THEN RETURN pre; END IF;
  IF agent_minutes_used(p_project) + p_minutes > 180 THEN
    RETURN agent_raise_halt(p_project, 'USAGE_CAP_EXCEEDED', 'agent_compute', format('recording %s min would pass the 180 min cap', p_minutes));
  END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  INSERT INTO usage_meter_events(customer_id, project_id, meter, quantity, source) VALUES (c, p_project, 'agent_minutes', p_minutes, session_user);
  RETURN jsonb_build_object('recorded', p_minutes, 'agent_minutes_left', 180 - agent_minutes_used(p_project));
END $$;

-- Execution -> Verification (DIR §5.2). passed = every check passed; computed here, never trusted from the caller.
CREATE OR REPLACE FUNCTION submit_verification_package(p_project UUID, p_consent UUID, p_release TEXT, p_checks JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pre JSONB; c UUID; ok BOOLEAN; v UUID; bad TEXT;
BEGIN
  pre := agent_preflight(p_project, p_consent, 'produce_verification_package', NULL, p_checks::text);
  IF pre ? 'halt' THEN RETURN pre; END IF;
  IF jsonb_typeof(p_checks) <> 'array' OR jsonb_array_length(p_checks) = 0 THEN RAISE EXCEPTION 'CHECKS_REQUIRED'; END IF;
  SELECT string_agg(coalesce(e->>'name', '?'), ',') INTO bad FROM jsonb_array_elements(p_checks) e
    WHERE coalesce(e->>'name', '') !~ '^[a-z0-9_.:-]{2,60}$' OR coalesce(e->>'status', '') NOT IN ('pass','fail')
       OR coalesce(e->>'evidence_sha256', '') !~ '^[a-f0-9]{64}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'INVALID_CHECKS: %', bad; END IF;
  IF (SELECT count(DISTINCT e->>'name') FROM jsonb_array_elements(p_checks) e) <> jsonb_array_length(p_checks) THEN RAISE EXCEPTION 'DUPLICATE_CHECK_NAMES'; END IF;
  ok := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_checks) e WHERE e->>'status' <> 'pass');
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  INSERT INTO verification_packages(project_id, customer_id, release_ref, consent_id, checks, passed, evidence_sha256, submitted_by)
    VALUES (p_project, c, p_release, p_consent, p_checks, ok, encode(digest(p_checks::text, 'sha256'), 'hex'), session_user) RETURNING id INTO v;
  IF NOT ok THEN
    PERFORM agent_raise_halt(p_project, 'VERIFICATION_FAILED', 'produce_verification_package', format('package %s for %s has failing checks', v, p_release));
  END IF;
  RETURN jsonb_build_object('package_id', v, 'passed', ok);
END $$;

-- Latest package for this exact release must have passed. NULL = ok, else the denial reason.
CREATE OR REPLACE FUNCTION verification_block_reason(p_project UUID, p_release TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN v.id IS NULL THEN 'VERIFICATION_PACKAGE_MISSING' WHEN NOT v.passed THEN 'VERIFICATION_FAILED' END
  FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT id, passed FROM verification_packages
    WHERE project_id = p_project AND release_ref = p_release ORDER BY submitted_at DESC, id DESC LIMIT 1) v ON true
$$;

-- Verification -> Staging (DIR §5.2): checks passed + the customer's implementation consent behind the package (HITL).
CREATE OR REPLACE FUNCTION promote_to_staging(p_project UUID, p_release TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; why TEXT; pkg UUID;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_deploy_orchestrator', 'MEMBER') THEN RAISE EXCEPTION 'NOT_DEPLOY_ORCHESTRATOR'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('staging:' || p_project));
  SELECT id INTO pkg FROM verification_packages WHERE project_id = p_project AND release_ref = p_release ORDER BY submitted_at DESC, id DESC LIMIT 1;
  why := COALESCE(
    CASE WHEN EXISTS (SELECT 1 FROM agent_halts WHERE project_id = p_project AND sticky AND cleared_at IS NULL) THEN 'PROJECT_HALTED_PENDING_OPERATOR_REVIEW' END,
    verification_block_reason(p_project, p_release),
    CASE WHEN (SELECT consent_id FROM verification_packages WHERE id = pkg) IS NULL THEN 'CUSTOMER_IMPLEMENTATION_CONSENT_MISSING' END,
    -- BDD_F10_02: staging deploys / project / month = 15 (DIR 10.3; same value as lib/usage/meters.ts BETA_CAPS).
    CASE WHEN (SELECT COALESCE(sum(quantity), 0) FROM usage_meter_events WHERE project_id = p_project AND meter = 'staging_deploys'
          AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') >= 15 THEN 'STAGING_DEPLOY_CAP_REACHED' END);
  IF why IS NOT NULL THEN
    INSERT INTO staging_promotions(project_id, customer_id, release_ref, package_id, outcome, reason, requested_by) VALUES (p_project, c, p_release, pkg, 'DENIED', why, session_user);
    RETURN jsonb_build_object('denied', why);
  END IF;
  INSERT INTO usage_meter_events(customer_id, project_id, meter, quantity, source) VALUES (c, p_project, 'staging_deploys', 1, 'deploy_orchestrator');
  INSERT INTO staging_promotions(project_id, customer_id, release_ref, package_id, outcome, reason, requested_by)
    VALUES (p_project, c, p_release, pkg, 'PROMOTED', 'verification package ' || pkg || ' passed', session_user);
  RETURN jsonb_build_object('staging', 'PROMOTED', 'package_id', pkg);
END $$;

-- Operator review clears a sticky halt (injection / cross-tenant). Reason required; the agent cannot clear its own.
CREATE OR REPLACE FUNCTION clear_agent_halt(p_halt UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h agent_halts;
BEGIN
  IF NOT pg_has_role(session_user, 'nasi_agent_halt_reviewer', 'MEMBER') THEN RAISE EXCEPTION 'NOT_AGENT_HALT_REVIEWER'; END IF;
  IF pg_has_role(session_user, 'nasi_agent_runtime', 'MEMBER') THEN RAISE EXCEPTION 'AGENT_CANNOT_CLEAR_HALT'; END IF;
  IF length(trim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT * INTO h FROM agent_halts WHERE id = p_halt FOR UPDATE;
  IF h.id IS NULL OR NOT h.sticky OR h.cleared_at IS NOT NULL THEN RAISE EXCEPTION 'NO_OPEN_HALT'; END IF;
  UPDATE agent_halts SET cleared_by = session_user, cleared_at = now(), clear_reason = p_reason WHERE id = p_halt;
  RETURN jsonb_build_object('cleared', p_halt, 'trigger', h.trigger);
END $$;

-- ---------- production credential now also requires a passed verification package (replaces 013 versions) ----------
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
    WHEN EXISTS (SELECT 1 FROM agent_halts WHERE project_id = p_project AND sticky AND cleared_at IS NULL) THEN 'PROJECT_HALTED_PENDING_OPERATOR_REVIEW'
    WHEN verification_block_reason(p_project, p_release) IS NOT NULL THEN verification_block_reason(p_project, p_release)
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

CREATE OR REPLACE FUNCTION redeem_production_deploy_credential(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k production_deploy_credentials; a customer_release_authorizations; b platform_production_authorizations; why TEXT;
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
    WHEN EXISTS (SELECT 1 FROM agent_halts WHERE project_id = k.project_id AND sticky AND cleared_at IS NULL) THEN 'PROJECT_HALTED_PENDING_OPERATOR_REVIEW'
    WHEN verification_block_reason(k.project_id, k.release_ref) IS NOT NULL THEN 'VERIFICATION_NO_LONGER_VALID'
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

-- ---------- privileges ----------
REVOKE ALL ON FUNCTION agent_raise_halt(UUID,TEXT,TEXT,TEXT), agent_input_suspicious(TEXT), agent_consent_valid(UUID,UUID), agent_minutes_used(UUID),
  agent_preflight(UUID,UUID,TEXT,UUID,TEXT), agent_record_minutes(UUID,UUID,NUMERIC), submit_verification_package(UUID,UUID,TEXT,JSONB),
  verification_block_reason(UUID,TEXT), promote_to_staging(UUID,TEXT), clear_agent_halt(UUID,TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nasi_agent_runtime, nasi_agent_halt_reviewer;
GRANT EXECUTE ON FUNCTION agent_preflight(UUID,UUID,TEXT,UUID,TEXT), agent_record_minutes(UUID,UUID,NUMERIC), submit_verification_package(UUID,UUID,TEXT,JSONB) TO nasi_agent_runtime;
GRANT EXECUTE ON FUNCTION promote_to_staging(UUID,TEXT) TO nasi_deploy_orchestrator;
GRANT EXECUTE ON FUNCTION clear_agent_halt(UUID,TEXT) TO nasi_agent_halt_reviewer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION agent_raise_halt(UUID,TEXT,TEXT,TEXT), agent_input_suspicious(TEXT), agent_consent_valid(UUID,UUID), agent_minutes_used(UUID),
      agent_preflight(UUID,UUID,TEXT,UUID,TEXT), agent_record_minutes(UUID,UUID,NUMERIC), submit_verification_package(UUID,UUID,TEXT,JSONB),
      verification_block_reason(UUID,TEXT), promote_to_staging(UUID,TEXT), clear_agent_halt(UUID,TEXT) FROM nasi_app_runtime;
    REVOKE ALL ON verification_packages, agent_halts, staging_promotions FROM nasi_app_runtime;
    GRANT SELECT ON verification_packages, agent_halts, staging_promotions TO nasi_app_runtime;
  END IF;
END $$;
