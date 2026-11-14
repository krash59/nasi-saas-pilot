-- 015: stage entry/exit artifacts per DIR §5.2 (BDD_F07_01, card S07_01).
-- DIR -> Agile/BDD exit artifact: a story set (stories + Gherkin AC) generated from the approved DIR as AI_DRAFT.
-- Agile/BDD -> Kanban entry: the customer accepts that exact story set, bound to the current approved DIR digest.
-- The database enforces entry artifacts for every stage from kanban on, so no stage can be skipped:
--   kanban       accepted story set matching the approved DIR
--   agentic      kanban gate + active implementation consent (consents cannot be created before kanban)
--   verification kanban gate + a passed verification package
--   staging      kanban gate + a PROMOTED staging promotion
--   production   kanban gate + a REDEEMED production deploy
-- Earlier stages (summary review, dir, agile_bdd) are gated by the app paths verified under S03/S04.
-- Staging -> Production: a production credential is only issued for a release that was promoted to staging.
-- Stages advance automatically when the artifact is recorded; moving back (a new work cycle) is allowed. Idempotent.

CREATE TABLE IF NOT EXISTS story_sets (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dir_sha256 TEXT NOT NULL CHECK (dir_sha256 ~ '^[a-f0-9]{64}$'),
  stories JSONB NOT NULL CHECK (jsonb_typeof(stories) = 'array' AND jsonb_array_length(stories) > 0),
  status TEXT NOT NULL DEFAULT 'AI_DRAFT' CHECK (status IN ('AI_DRAFT','accepted')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
);
ALTER TABLE story_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS story_sets_isolation ON story_sets;
CREATE POLICY story_sets_isolation ON story_sets FOR ALL
  USING (customer_id = app_current_customer_id() AND project_id IN (SELECT id FROM projects WHERE customer_id = app_current_customer_id()))
  WITH CHECK (customer_id = app_current_customer_id() AND project_id IN (SELECT id FROM projects WHERE customer_id = app_current_customer_id()));

CREATE OR REPLACE FUNCTION stage_ordinal(p_stage TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(ARRAY['design_discussion','design_summary_review','dir','agile_bdd','kanban','agentic','verification','staging','production'], p_stage)
$$;

-- NULL = entry artifacts present; otherwise the missing artifact.
CREATE OR REPLACE FUNCTION stage_entry_block(p_project UUID, p_stage TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE dir_sha TEXT;
BEGIN
  IF stage_ordinal(p_stage) IS NULL THEN RETURN 'UNKNOWN_STAGE'; END IF;
  IF stage_ordinal(p_stage) < stage_ordinal('kanban') THEN RETURN NULL; END IF;
  SELECT encode(digest(content::text, 'sha256'), 'hex') INTO dir_sha FROM dir_drafts
    WHERE project_id = p_project AND status = 'approved' AND approved_at IS NOT NULL;
  IF dir_sha IS NULL THEN RETURN 'DIR_NOT_APPROVED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM story_sets WHERE project_id = p_project AND status = 'accepted' AND dir_sha256 = dir_sha) THEN
    RETURN 'STORY_SET_NOT_ACCEPTED';
  END IF;
  IF p_stage = 'agentic' AND NOT EXISTS (SELECT 1 FROM implementation_consents WHERE project_id = p_project
       AND revoked_at IS NULL AND expires_at > now() AND dir_sha256 = dir_sha) THEN RETURN 'IMPLEMENTATION_CONSENT_MISSING'; END IF;
  IF p_stage = 'verification' AND NOT EXISTS (SELECT 1 FROM verification_packages WHERE project_id = p_project AND passed) THEN
    RETURN 'VERIFICATION_PACKAGE_NOT_PASSED'; END IF;
  IF p_stage = 'staging' AND NOT EXISTS (SELECT 1 FROM staging_promotions WHERE project_id = p_project AND outcome = 'PROMOTED') THEN
    RETURN 'STAGING_RELEASE_MISSING'; END IF;
  IF p_stage = 'production' AND NOT EXISTS (SELECT 1 FROM production_deploy_decisions WHERE project_id = p_project AND outcome = 'REDEEMED') THEN
    RETURN 'PRODUCTION_DEPLOY_MISSING'; END IF;
  RETURN NULL;
END $$;

-- Forward moves must have every entry artifact; this is what stops a stage being skipped.
CREATE OR REPLACE FUNCTION projects_stage_gate() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE why TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND stage_ordinal(NEW.lifecycle_stage) <= stage_ordinal(OLD.lifecycle_stage) THEN RETURN NEW; END IF;
  why := stage_entry_block(NEW.id, NEW.lifecycle_stage);
  IF why IS NOT NULL THEN RAISE EXCEPTION 'STAGE_GATE_%: % requires missing artifact', why, NEW.lifecycle_stage USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS projects_stage_gate ON projects;
CREATE TRIGGER projects_stage_gate BEFORE INSERT OR UPDATE OF lifecycle_stage ON projects FOR EACH ROW EXECUTE FUNCTION projects_stage_gate();

-- Kanban -> Agentic execution: implementation consent only for a project whose story set is accepted.
CREATE OR REPLACE FUNCTION implementation_consent_gate() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE why TEXT := stage_entry_block(NEW.project_id, 'kanban');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION 'STAGE_GATE_%: implementation consent requires an accepted story set', why USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS implementation_consent_gate ON implementation_consents;
CREATE TRIGGER implementation_consent_gate BEFORE INSERT ON implementation_consents FOR EACH ROW EXECUTE FUNCTION implementation_consent_gate();

-- Staging -> Production: production credentials only for a release promoted to staging.
CREATE OR REPLACE FUNCTION production_credential_gate() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staging_promotions WHERE project_id = NEW.project_id AND release_ref = NEW.release_ref AND outcome = 'PROMOTED') THEN
    RAISE EXCEPTION 'STAGE_GATE_STAGING_RELEASE_MISSING: release % was never promoted to staging', NEW.release_ref USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_credential_gate ON production_deploy_credentials;
CREATE TRIGGER production_credential_gate BEFORE INSERT ON production_deploy_credentials FOR EACH ROW EXECUTE FUNCTION production_credential_gate();

-- Exit artifacts advance the stage (only forward; the projects trigger re-checks every entry artifact).
CREATE OR REPLACE FUNCTION advance_stage(p_project UUID, p_stage TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  -- Bookkeeping only: the artifact chain (consent needs kanban, package needs consent, staging needs package,
  -- production credential needs staging) is enforced by the gates above, so this never raises.
  UPDATE projects SET lifecycle_stage = p_stage WHERE id = p_project AND stage_ordinal(lifecycle_stage) < stage_ordinal(p_stage)
    AND stage_entry_block(p_project, p_stage) IS NULL
$$;
CREATE OR REPLACE FUNCTION stage_advance_on_artifact() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Nested IFs: PL/pgSQL does not short-circuit, and each table has different columns.
  IF TG_TABLE_NAME = 'implementation_consents' THEN PERFORM advance_stage(NEW.project_id, 'agentic');
  ELSIF TG_TABLE_NAME = 'verification_packages' THEN
    IF NEW.passed THEN PERFORM advance_stage(NEW.project_id, 'verification'); END IF;
  ELSIF TG_TABLE_NAME = 'staging_promotions' THEN
    IF NEW.outcome = 'PROMOTED' THEN PERFORM advance_stage(NEW.project_id, 'staging'); END IF;
  ELSIF TG_TABLE_NAME = 'production_deploy_decisions' THEN
    IF NEW.outcome = 'REDEEMED' THEN PERFORM advance_stage(NEW.project_id, 'production'); END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS stage_advance ON implementation_consents;
CREATE TRIGGER stage_advance AFTER INSERT ON implementation_consents FOR EACH ROW EXECUTE FUNCTION stage_advance_on_artifact();
DROP TRIGGER IF EXISTS stage_advance ON verification_packages;
CREATE TRIGGER stage_advance AFTER INSERT ON verification_packages FOR EACH ROW EXECUTE FUNCTION stage_advance_on_artifact();
DROP TRIGGER IF EXISTS stage_advance ON staging_promotions;
CREATE TRIGGER stage_advance AFTER INSERT ON staging_promotions FOR EACH ROW EXECUTE FUNCTION stage_advance_on_artifact();
DROP TRIGGER IF EXISTS stage_advance ON production_deploy_decisions;
CREATE TRIGGER stage_advance AFTER INSERT ON production_deploy_decisions FOR EACH ROW EXECUTE FUNCTION stage_advance_on_artifact();

REVOKE ALL ON FUNCTION stage_entry_block(UUID,TEXT), advance_stage(UUID,TEXT), projects_stage_gate(), implementation_consent_gate(),
  production_credential_gate(), stage_advance_on_artifact() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    REVOKE EXECUTE ON FUNCTION advance_stage(UUID,TEXT), projects_stage_gate(), implementation_consent_gate(),
      production_credential_gate(), stage_advance_on_artifact() FROM nasi_app_runtime;
    GRANT EXECUTE ON FUNCTION stage_entry_block(UUID,TEXT), stage_ordinal(TEXT) TO nasi_app_runtime;
    REVOKE ALL ON story_sets FROM nasi_app_runtime;
    GRANT SELECT, INSERT, UPDATE ON story_sets TO nasi_app_runtime;
  END IF;
END $$;
