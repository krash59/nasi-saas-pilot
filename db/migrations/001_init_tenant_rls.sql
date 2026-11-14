-- Wave 1: accounts, projects, tenant columns, RLS (DIR §4.2)
-- Run with role that can CREATE POLICY; app runtime uses app_user without BYPASSRLS.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);

-- Session GUC for RLS: SET app.current_customer_id = '<uuid>'

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_current_customer_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_customer_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS customers_select ON customers;
DROP POLICY IF EXISTS projects_isolation ON projects;

CREATE POLICY customers_select ON customers
  FOR SELECT
  USING (id = app_current_customer_id());

CREATE POLICY projects_isolation ON projects
  FOR ALL
  USING (customer_id = app_current_customer_id())
  WITH CHECK (customer_id = app_current_customer_id());

-- Registration before customer UUID exists: SECURITY DEFINER (not BYPASSRLS on app role)
CREATE OR REPLACE FUNCTION register_customer(p_clerk_user_id TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO customers (clerk_user_id)
  VALUES (p_clerk_user_id)
  ON CONFLICT (clerk_user_id) DO UPDATE
  SET clerk_user_id = EXCLUDED.clerk_user_id
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- App runtime role (create manually in Neon; grant SELECT/INSERT/UPDATE/DELETE)
-- CREATE ROLE app_user LOGIN PASSWORD '...';
-- GRANT USAGE ON SCHEMA public TO app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON customers, projects TO app_user;
-- Do NOT grant BYPASSRLS.
