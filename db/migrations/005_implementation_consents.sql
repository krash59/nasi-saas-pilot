-- Customer consent is separate from NWS execution and production release.
CREATE TABLE implementation_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  dir_sha256 TEXT NOT NULL CHECK (dir_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by TEXT NOT NULL CHECK (length(trim(approved_by)) > 0),
  implementation_scope TEXT NOT NULL DEFAULT 'nonproduction'
    CHECK (implementation_scope = 'nonproduction'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > granted_at)
);
ALTER TABLE implementation_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY implementation_consents_isolation ON implementation_consents FOR ALL
 USING (customer_id = app_current_customer_id() AND project_id IN
   (SELECT id FROM projects WHERE customer_id = app_current_customer_id()))
 WITH CHECK (customer_id = app_current_customer_id() AND project_id IN
   (SELECT id FROM projects WHERE customer_id = app_current_customer_id()));
