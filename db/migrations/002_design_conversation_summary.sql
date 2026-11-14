-- Wave 2: design conversation, messages, summary (DIR §2.2)

ALTER TABLE projects ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'design_discussion'
  CHECK (lifecycle_stage IN (
    'design_discussion',
    'design_summary_review',
    'dir',
    'agile_bdd',
    'kanban',
    'agentic',
    'verification',
    'staging',
    'production'
  ));

CREATE TABLE IF NOT EXISTS design_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'assistant')),
  content TEXT NOT NULL,
  is_ai_draft BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_design_messages_project ON design_messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS design_summaries (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready_for_review', 'approved')),
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE design_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS design_messages_isolation ON design_messages;
CREATE POLICY design_messages_isolation ON design_messages
  FOR ALL
  USING (
    project_id IN (
      SELECT id FROM projects WHERE customer_id = app_current_customer_id()
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects WHERE customer_id = app_current_customer_id()
    )
  );

DROP POLICY IF EXISTS design_summaries_isolation ON design_summaries;
CREATE POLICY design_summaries_isolation ON design_summaries
  FOR ALL
  USING (
    project_id IN (
      SELECT id FROM projects WHERE customer_id = app_current_customer_id()
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects WHERE customer_id = app_current_customer_id()
    )
  );
