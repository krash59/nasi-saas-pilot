-- 019: deterministic design intake (owner rule 2026-11-19; design v3, reports/Deterministic requirements capture from chat.md).
-- Additive only; idempotent (safe to re-run, like 018).
-- intake_events: the append-only, authoritative log of what the CUSTOMER said and clicked (R1). Answers are bound to the
--   question that was active when they arrived (R3). Summary, DIR and stories are pure projections of this log.
-- ai_suggestions: AI replies/proposals kept for audit only, marked non-authoritative; no projection reads it (R4, R22, D1).

CREATE TABLE IF NOT EXISTS intake_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  seq INT NOT NULL CHECK (seq >= 1),
  protocol_version TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'AnswerGiven', 'NextPressed', 'FieldMarkedNone', 'AnswerAmended', 'AnswerWithdrawn', 'MessageMoved',
    'AnswerReplaced', 'SectionConfirmed', 'OpenQuestionStatusSet', 'DecisionRecorded')),
  question_id TEXT,
  message_id UUID,
  item_id TEXT,
  verbatim_text TEXT,
  status TEXT,
  actor TEXT NOT NULL DEFAULT 'customer' CHECK (actor = 'customer'),
  audit_ts TIMESTAMPTZ NOT NULL DEFAULT now(),  -- audit only; never part of the canonical record (R19, D3)
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_intake_events_project ON intake_events(project_id, seq);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('interviewer_reply', 'proposal')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  content TEXT NOT NULL,
  quote_check TEXT,
  authoritative BOOLEAN NOT NULL DEFAULT false CHECK (authoritative = false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_project ON ai_suggestions(project_id, created_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['intake_events', 'ai_suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (customer_id = app_current_customer_id() AND project_id IN '
                   '(SELECT id FROM projects WHERE customer_id = app_current_customer_id())) WITH CHECK (customer_id = '
                   'app_current_customer_id() AND project_id IN (SELECT id FROM projects WHERE customer_id = app_current_customer_id()))',
                   t || '_isolation', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nasi_append_only_guard()',
                   t || '_append_only', t);
    -- TRUNCATE does not fire row triggers (PostgreSQL docs); the app role's TRUNCATE right is revoked below instead, the
    -- same as the other append-only tables, so administrative TRUNCATE ... CASCADE resets of disposable test DBs still work.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    GRANT SELECT, INSERT ON intake_events, ai_suggestions TO nasi_app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON intake_events, ai_suggestions FROM nasi_app_runtime;
  END IF;
END $$;
