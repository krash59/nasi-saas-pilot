-- 007: least-privilege app runtime role (closes S05_01 / S05_02 runtime gap).
-- Idempotent: safe to run more than once.
-- nasi_app_runtime is a NOLOGIN group role. Each environment creates its own LOGIN user
-- (password kept outside git) and grants it this role, e.g.:
--   CREATE ROLE nasi_app LOGIN PASSWORD '<secret>' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_app_runtime') THEN
    CREATE ROLE nasi_app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO nasi_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nasi_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nasi_app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nasi_app_runtime;

-- Tables created by later migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nasi_app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO nasi_app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO nasi_app_runtime;
-- Note: no FORCE RLS on customers here; register_customer() is SECURITY DEFINER and
-- must insert as the owner. The app role is not the owner, so normal RLS applies to it.
