-- DIR §5.2: one persistent, retry-safe draft per approved Design Summary.
CREATE TABLE IF NOT EXISTS dir_drafts (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'AI_DRAFT' CHECK (status = 'AI_DRAFT'),
  content JSONB NOT NULL,
  source_summary JSONB NOT NULL,
  source_approved_at TIMESTAMPTZ NOT NULL,
  generated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dir_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dir_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dir_drafts_isolation ON dir_drafts;
CREATE POLICY dir_drafts_isolation ON dir_drafts FOR ALL
  USING (customer_id = app_current_customer_id() AND project_id IN
    (SELECT id FROM projects WHERE customer_id = app_current_customer_id()))
  WITH CHECK (customer_id = app_current_customer_id() AND project_id IN
    (SELECT id FROM projects WHERE customer_id = app_current_customer_id()));
