-- 010: usage meters (BDD_F10_01 / BDD_F10_02, DIR §10.2 §10.3).
-- Append-only ledger: the runtime role may INSERT and read its own tenant's rows, never UPDATE/DELETE.
-- Meters: design_tokens (per account), agent_minutes, staging_deploys, production_deploys (per project).
-- Idempotent.
CREATE TABLE IF NOT EXISTS usage_meter_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  meter TEXT NOT NULL CHECK (meter IN ('design_tokens','agent_minutes','staging_deploys','production_deploys')),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (meter = 'design_tokens' OR project_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_usage_meter_events_period ON usage_meter_events(customer_id, meter, occurred_at);

ALTER TABLE usage_meter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_meter_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_meter_events_insert ON usage_meter_events;
DROP POLICY IF EXISTS usage_meter_events_select ON usage_meter_events;
CREATE POLICY usage_meter_events_insert ON usage_meter_events FOR INSERT
  WITH CHECK (customer_id = app_current_customer_id() AND (project_id IS NULL OR project_id IN
    (SELECT id FROM projects WHERE customer_id = app_current_customer_id())));
CREATE POLICY usage_meter_events_select ON usage_meter_events FOR SELECT
  USING (customer_id = app_current_customer_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    GRANT SELECT, INSERT ON usage_meter_events TO nasi_app_runtime;
    REVOKE UPDATE, DELETE ON usage_meter_events FROM nasi_app_runtime;
  END IF;
END $$;
