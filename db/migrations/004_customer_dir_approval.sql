-- Explicit customer approval of the persisted DIR; no implementation authority.
ALTER TABLE dir_drafts DROP CONSTRAINT IF EXISTS dir_drafts_status_check;
ALTER TABLE dir_drafts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE dir_drafts ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE dir_drafts ADD CONSTRAINT dir_drafts_status_check CHECK (
  (status = 'AI_DRAFT' AND approved_at IS NULL AND approved_by IS NULL) OR
  (status = 'approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL AND length(trim(approved_by)) > 0)
);
