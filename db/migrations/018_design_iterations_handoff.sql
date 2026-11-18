-- 018: owner walkthrough cards (2026-11-17), built 2026-11-18. Additive only; idempotent.
-- DC-01 edit/withdraw a customer chat message before Design Summary approval; append-only revision history.
-- DC-03 design iterations: each Revise archives the current round (summary, DIR, stories, consents) as an immutable
--       version and reopens the design chat; earlier versions are never overwritten.
-- DC-06 NWS handoff: the full job (approved DIR content, accepted stories with tests, consent and scope) is recorded
--       as sent; NWS records its receipt through one narrow function, which the app reads back.
-- dir_drafts and story_sets keep ONE row per project (NWS's pinned product reader requires exactly one).

ALTER TABLE design_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE design_messages ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_version INT NOT NULL DEFAULT 1 CHECK (design_version >= 1);

CREATE TABLE IF NOT EXISTS design_message_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES design_messages(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('edit', 'withdraw')),
  previous_content TEXT NOT NULL,
  new_content TEXT,
  revised_by TEXT NOT NULL,
  revised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((action = 'edit') = (new_content IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_design_message_revisions_msg ON design_message_revisions(message_id, revised_at);

CREATE TABLE IF NOT EXISTS design_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  summary JSONB NOT NULL,
  dir JSONB,
  stories JSONB,
  voided_consent_ids UUID[] NOT NULL DEFAULT '{}',
  archived_by TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS nws_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  consent_id UUID NOT NULL REFERENCES implementation_consents(id) ON DELETE CASCADE,
  design_version INT NOT NULL,
  job JSONB NOT NULL,
  job_sha256 TEXT NOT NULL CHECK (job_sha256 ~ '^[a-f0-9]{64}$'),
  sent_by TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  receipt JSONB,
  received_at TIMESTAMPTZ,
  CHECK ((receipt IS NULL) = (received_at IS NULL)),
  UNIQUE (consent_id, job_sha256)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['design_message_revisions', 'design_versions', 'nws_handoffs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (customer_id = app_current_customer_id() AND project_id IN '
                   '(SELECT id FROM projects WHERE customer_id = app_current_customer_id())) WITH CHECK (customer_id = '
                   'app_current_customer_id() AND project_id IN (SELECT id FROM projects WHERE customer_id = app_current_customer_id()))',
                   t || '_isolation', t);
  END LOOP;
  -- History is append-only (same guard as 017).
  FOREACH t IN ARRAY ARRAY['design_message_revisions', 'design_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nasi_append_only_guard()',
                   t || '_append_only', t);
  END LOOP;
END $$;

-- A handoff, once sent, is immutable except for the single NWS receipt write (made only by nws_record_handoff_receipt).
CREATE OR REPLACE FUNCTION nws_handoff_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Same legitimate delete paths as nasi_append_only_guard (017): parent cascade, retention purge, named maintenance.
    IF pg_trigger_depth() > 1 OR coalesce(current_setting('nasi.audit_maintenance', true), '') = 'on'
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_retention_purge')
           AND pg_has_role(current_user, 'nasi_retention_purge', 'USAGE')
           AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'NWS_HANDOFF_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.project_id, NEW.customer_id, NEW.consent_id, NEW.design_version, NEW.job, NEW.job_sha256, NEW.sent_by, NEW.sent_at)
     IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.customer_id, OLD.consent_id, OLD.design_version, OLD.job, OLD.job_sha256, OLD.sent_by, OLD.sent_at)
     OR OLD.receipt IS NOT NULL OR current_setting('nasi.nws_receipt_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'NWS_HANDOFF_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nws_handoffs_guard ON nws_handoffs;
CREATE TRIGGER nws_handoffs_guard BEFORE UPDATE OR DELETE ON nws_handoffs FOR EACH ROW EXECUTE FUNCTION nws_handoff_guard();

-- NWS intake identity: may only record a receipt for a handoff whose job digest it actually received.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_nws_intake') THEN CREATE ROLE nasi_nws_intake NOLOGIN; END IF;
END $$;
CREATE OR REPLACE FUNCTION nws_record_handoff_receipt(p_customer UUID, p_handoff UUID, p_job_sha256 TEXT, p_receipt JSONB) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r nws_handoffs%ROWTYPE; at TIMESTAMPTZ;
BEGIN
  -- Tenant-bound: FORCE RLS applies to the owner too, so the caller names the tenant and sees only its rows.
  PERFORM set_config('app.current_customer_id', p_customer::text, true);
  SELECT * INTO r FROM nws_handoffs WHERE id = p_handoff AND customer_id = p_customer FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'HANDOFF_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF r.job_sha256 <> p_job_sha256 THEN RAISE EXCEPTION 'HANDOFF_DIGEST_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  IF r.receipt IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_ALREADY_RECEIVED' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_typeof(p_receipt) <> 'object' OR p_receipt->>'job_sha256' IS DISTINCT FROM p_job_sha256 THEN
    RAISE EXCEPTION 'HANDOFF_RECEIPT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('nasi.nws_receipt_write', 'on', true);
  UPDATE nws_handoffs SET receipt = p_receipt, received_at = now() WHERE id = p_handoff RETURNING received_at INTO at;
  PERFORM set_config('nasi.nws_receipt_write', 'off', true);
  RETURN at;
END $$;
-- Read the queued job (SECURITY DEFINER: the intake role holds no table rights).
CREATE OR REPLACE FUNCTION nws_read_handoff(p_customer UUID, p_handoff UUID) RETURNS TABLE(id UUID, project_id UUID, customer_id UUID,
  consent_id UUID, design_version INT, job JSONB, job_sha256 TEXT, sent_at TIMESTAMPTZ, received_at TIMESTAMPTZ, consent_current BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.current_customer_id', p_customer::text, true);
  RETURN QUERY SELECT h.id, h.project_id, h.customer_id, h.consent_id, h.design_version, h.job, h.job_sha256, h.sent_at, h.received_at,
         (c.revoked_at IS NULL AND c.expires_at > now()) AS consent_current
    FROM nws_handoffs h JOIN implementation_consents c ON c.id = h.consent_id
    WHERE h.id = p_handoff AND h.customer_id = p_customer;
END $$;
REVOKE ALL ON FUNCTION nws_record_handoff_receipt(UUID, UUID, TEXT, JSONB), nws_read_handoff(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nws_record_handoff_receipt(UUID, UUID, TEXT, JSONB), nws_read_handoff(UUID, UUID) TO nasi_nws_intake;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION nws_record_handoff_receipt(UUID, UUID, TEXT, JSONB), nws_read_handoff(UUID, UUID) FROM nasi_app_runtime;
    GRANT SELECT, INSERT ON design_message_revisions, design_versions, nws_handoffs TO nasi_app_runtime;
    REVOKE UPDATE, DELETE ON design_message_revisions, design_versions, nws_handoffs FROM nasi_app_runtime;
  END IF;
END $$;
