-- 016: operator MFA for privileged accounts (S02_01, BDD_F02_01, DIR §4.1 "Operators: MFA + RBAC", owner decision OPTION_A).
-- Time-based one-time passwords per IETF RFC 6238 (HMAC-SHA1, 30 s step, 6 digits; validated against the RFC
-- Appendix B test vectors in tests). Every privileged operator function (break-glass request/approve/read/close,
-- platform production authorization ACT_05B, agent-halt clearing) now requires a fresh MFA session for the SAME
-- login (session_user). Secrets live in a table no role can read; only SECURITY DEFINER functions use them.
-- Codes are single use (replay of the same time step is refused); a step of network delay is tolerated (RFC 6238 §5.2);
-- 5 failures in 15 minutes lock the login; every attempt is logged. Sessions last 10 minutes. Idempotent.

CREATE TABLE IF NOT EXISTS operator_mfa_enrollments (
  login TEXT PRIMARY KEY CHECK (login ~ '^[a-z_][a-z0-9_]{1,62}$'),
  secret BYTEA NOT NULL CHECK (octet_length(secret) >= 20),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrolled_by TEXT NOT NULL,
  last_used_step BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS operator_mfa_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS idx_operator_mfa_sessions_login ON operator_mfa_sessions(login, expires_at);
CREATE TABLE IF NOT EXISTS operator_mfa_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ENROLLED','VERIFIED','REJECTED','REPLAY_REJECTED','LOCKED','NOT_ENROLLED','MFA_REQUIRED_DENIED')),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE operator_mfa_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_mfa_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_mfa_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_mfa_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_mfa_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_mfa_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON operator_mfa_enrollments, operator_mfa_sessions, operator_mfa_log FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_operator_mfa_admin') THEN
    CREATE ROLE nasi_operator_mfa_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- RFC 6238 TOTP (RFC 4226 dynamic truncation), HMAC-SHA1. p_step = floor(unix_time / 30).
CREATE OR REPLACE FUNCTION operator_totp(p_secret BYTEA, p_step BIGINT, p_digits INT DEFAULT 6) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public AS $$
DECLARE h BYTEA; o INT; bin BIGINT;
BEGIN
  h := hmac(int8send(p_step), p_secret, 'sha1');
  o := get_byte(h, 19) & 15;
  bin := ((get_byte(h, o) & 127)::BIGINT << 24) | (get_byte(h, o + 1)::BIGINT << 16) | (get_byte(h, o + 2)::BIGINT << 8) | get_byte(h, o + 3)::BIGINT;
  RETURN lpad((bin % (10::BIGINT ^ p_digits)::BIGINT)::TEXT, p_digits, '0');
END $$;

-- Owner-run enrollment (via scripts/operator-mfa.mjs as the DB owner, or a member of nasi_operator_mfa_admin).
CREATE OR REPLACE FUNCTION operator_mfa_enroll(p_login TEXT, p_secret BYTEA) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (pg_has_role(session_user, 'nasi_operator_mfa_admin', 'MEMBER') OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)) THEN
    RAISE EXCEPTION 'NOT_MFA_ADMIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_login AND rolcanlogin) THEN RAISE EXCEPTION 'OPERATOR_LOGIN_NOT_FOUND'; END IF;
  INSERT INTO operator_mfa_enrollments(login, secret, enrolled_by) VALUES (p_login, p_secret, session_user)
    ON CONFLICT (login) DO UPDATE SET secret = EXCLUDED.secret, enrolled_at = now(), enrolled_by = EXCLUDED.enrolled_by, last_used_step = 0;
  DELETE FROM operator_mfa_sessions WHERE login = p_login;
  INSERT INTO operator_mfa_log(login, outcome) VALUES (p_login, 'ENROLLED');
END $$;

-- The operator proves possession of their authenticator for THIS login; opens a 10-minute MFA session.
CREATE OR REPLACE FUNCTION operator_mfa_verify(p_code TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e operator_mfa_enrollments; step BIGINT := floor(extract(epoch FROM clock_timestamp()) / 30)::BIGINT; s BIGINT; matched BIGINT;
BEGIN
  SELECT * INTO e FROM operator_mfa_enrollments WHERE login = session_user FOR UPDATE;
  IF e.login IS NULL THEN
    INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'NOT_ENROLLED'); RETURN jsonb_build_object('denied', 'MFA_NOT_ENROLLED');
  END IF;
  IF (SELECT count(*) FROM operator_mfa_log WHERE login = session_user AND outcome IN ('REJECTED','REPLAY_REJECTED') AND at > now() - interval '15 minutes') >= 5 THEN
    INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'LOCKED'); RETURN jsonb_build_object('denied', 'MFA_LOCKED');
  END IF;
  IF coalesce(p_code, '') !~ '^[0-9]{6}$' THEN
    INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'REJECTED'); RETURN jsonb_build_object('denied', 'MFA_CODE_INVALID');
  END IF;
  FOREACH s IN ARRAY ARRAY[step, step - 1, step + 1] LOOP          -- RFC 6238 §5.2: at most one step of network delay
    IF operator_totp(e.secret, s) = p_code THEN matched := s; EXIT; END IF;
  END LOOP;
  IF matched IS NULL THEN
    INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'REJECTED'); RETURN jsonb_build_object('denied', 'MFA_CODE_INVALID');
  END IF;
  IF matched <= e.last_used_step THEN                               -- single use: a used step (or earlier) is refused
    INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'REPLAY_REJECTED'); RETURN jsonb_build_object('denied', 'MFA_CODE_ALREADY_USED');
  END IF;
  UPDATE operator_mfa_enrollments SET last_used_step = matched WHERE login = session_user;
  INSERT INTO operator_mfa_sessions(login) VALUES (session_user);
  INSERT INTO operator_mfa_log(login, outcome) VALUES (session_user, 'VERIFIED');
  RETURN jsonb_build_object('mfa', 'VERIFIED', 'expires_at', now() + interval '10 minutes');
END $$;

-- Gate called first by every privileged operator function. It RAISES (enforcement), which rolls back anything written in
-- the same transaction, so the refusal record is written by operator_mfa_note_denial() (called by the operator tools in a
-- separate statement) and the raised error also lands in the PostgreSQL server log for calls that bypass the tools.
CREATE OR REPLACE FUNCTION require_operator_mfa() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operator_mfa_sessions WHERE login = session_user AND expires_at > now()) THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED';
  END IF;
END $$;

-- Lets operator tools skip sending a code while a session is still open (so codes are not re-sent and replay attempts
-- remain a real signal for the lockout). Reveals nothing but a boolean about the caller's own login.
CREATE OR REPLACE FUNCTION operator_mfa_session_active() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM operator_mfa_sessions WHERE login = session_user AND expires_at > now());
$$;

CREATE OR REPLACE FUNCTION operator_mfa_note_denial() RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO operator_mfa_log(login, outcome)
  SELECT session_user, 'MFA_REQUIRED_DENIED'
  WHERE NOT EXISTS (SELECT 1 FROM operator_mfa_sessions WHERE login = session_user AND expires_at > now());
$$;

REVOKE ALL ON FUNCTION operator_totp(BYTEA,BIGINT,INT), operator_mfa_enroll(TEXT,BYTEA), operator_mfa_verify(TEXT), require_operator_mfa(), operator_mfa_note_denial(), operator_mfa_session_active() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nasi_operator_mfa_admin;
GRANT EXECUTE ON FUNCTION operator_mfa_enroll(TEXT,BYTEA) TO nasi_operator_mfa_admin;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['nasi_break_glass','nasi_break_glass_approver','nasi_platform_release_approver','nasi_agent_halt_reviewer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('GRANT EXECUTE ON FUNCTION operator_mfa_verify(TEXT), operator_mfa_note_denial(), operator_mfa_session_active() TO %I', r); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION operator_totp(BYTEA,BIGINT,INT), operator_mfa_enroll(TEXT,BYTEA), operator_mfa_verify(TEXT), require_operator_mfa(), operator_mfa_note_denial(), operator_mfa_session_active() FROM nasi_app_runtime;
    REVOKE ALL ON operator_mfa_enrollments, operator_mfa_sessions, operator_mfa_log FROM nasi_app_runtime;
  END IF;
END $$;

-- Privileged operator functions: re-declared with the MFA gate as their first statement (bodies otherwise unchanged).
-- break_glass_request: body copied unchanged from 012_break_glass.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION break_glass_request(p_project UUID, p_reason TEXT, p_minutes INT,
  p_notify BOOLEAN DEFAULT true, p_exception TEXT DEFAULT NULL) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g UUID; c UUID;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
  IF NOT pg_has_role(session_user, 'nasi_break_glass', 'MEMBER') THEN RAISE EXCEPTION 'NOT_BREAK_GLASS_ENGINEER'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  INSERT INTO break_glass_grants(customer_id, project_id, engineer, reason, minutes, notify_customer, notification_exception)
    VALUES (c, p_project, session_user, p_reason, p_minutes, p_notify, p_exception) RETURNING id INTO g;
  PERFORM bg_log(g, c, 'REQUESTED', format('%s min requested: %s', p_minutes, p_reason));
  RETURN g;
END $$;

-- break_glass_approve: body copied unchanged from 012_break_glass.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION break_glass_approve(p_grant UUID) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
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

-- break_glass_read: body copied unchanged from 012_break_glass.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION break_glass_read(p_grant UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants; out JSONB;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
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

-- break_glass_close: body copied unchanged from 012_break_glass.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION break_glass_close(p_grant UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r break_glass_grants;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
  SELECT * INTO r FROM break_glass_grants WHERE id = p_grant FOR UPDATE;
  IF r.id IS NULL OR r.closed_at IS NOT NULL OR session_user NOT IN (r.engineer, coalesce(r.approver, '')) THEN RETURN false; END IF;
  UPDATE break_glass_grants SET closed_at = now() WHERE id = p_grant;
  PERFORM bg_log(r.id, r.customer_id, 'CLOSED', 'closed early');
  RETURN true;
END $$;

-- record_platform_production_authorization: body copied unchanged from 013_release_authorizations.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION record_platform_production_authorization(p_project UUID, p_release TEXT, p_decision TEXT, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c UUID; v_id UUID;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
  IF NOT pg_has_role(session_user, 'nasi_platform_release_approver', 'MEMBER') THEN RAISE EXCEPTION 'NOT_PLATFORM_RELEASE_APPROVER'; END IF;
  SELECT customer_id INTO c FROM projects WHERE id = p_project;
  IF c IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND'; END IF;
  INSERT INTO platform_production_authorizations(project_id, customer_id, release_ref, decision, decided_by, reason)
    VALUES (p_project, c, p_release, p_decision, session_user, p_reason) RETURNING platform_production_authorizations.id INTO v_id;
  RETURN v_id;
END $$;

-- clear_agent_halt: body copied unchanged from 014_verification_and_agent_halts.sql; only the MFA line above was added.
CREATE OR REPLACE FUNCTION clear_agent_halt(p_halt UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h agent_halts;
BEGIN
  PERFORM require_operator_mfa();   -- S02_01 (migration 016): fresh operator TOTP required
  IF NOT pg_has_role(session_user, 'nasi_agent_halt_reviewer', 'MEMBER') THEN RAISE EXCEPTION 'NOT_AGENT_HALT_REVIEWER'; END IF;
  IF pg_has_role(session_user, 'nasi_agent_runtime', 'MEMBER') THEN RAISE EXCEPTION 'AGENT_CANNOT_CLEAR_HALT'; END IF;
  IF length(trim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT * INTO h FROM agent_halts WHERE id = p_halt FOR UPDATE;
  IF h.id IS NULL OR NOT h.sticky OR h.cleared_at IS NOT NULL THEN RAISE EXCEPTION 'NO_OPEN_HALT'; END IF;
  UPDATE agent_halts SET cleared_by = session_user, cleared_at = now(), clear_reason = p_reason WHERE id = p_halt;
  RETURN jsonb_build_object('cleared', p_halt, 'trigger', h.trigger);
END $$;
