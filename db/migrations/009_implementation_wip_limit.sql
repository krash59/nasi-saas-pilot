-- 009: per-project implementation WIP limit (BDD_F07_02, DIR §5.2 "Default WIP").
-- An implementation consent that is neither revoked nor expired is one card in progress.
-- Default limit 1; raising it is a customer HITL decision (no app path raises it yet). Idempotent.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS implementation_wip_limit INT NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_implementation_wip_limit_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_implementation_wip_limit_check CHECK (implementation_wip_limit >= 1);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_implementation_consents_active
  ON implementation_consents(project_id) WHERE revoked_at IS NULL;
