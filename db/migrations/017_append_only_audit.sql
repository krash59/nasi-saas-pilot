-- 017: append-only audit data enforced by the database for EVERY role, including the table owner (FA-07; NIST SP 800-53
-- AU-9; NWS policy I4). Grants already stop the app runtime role; this also stops the owner/migration role, which is
-- what deleted operator_mfa_log rows in INCIDENT-1 (docs/BUILD_LOG.md:33).
-- A row UPDATE or DELETE on these tables is refused unless it is one of the legitimate paths:
--   * the retention purge: the current role holds nasi_retention_purge privileges (RLS policies still limit which rows),
--     and is not a superuser (superusers are members of every role);
--   * a cascade from deleting a parent row (customer erasure, project purge, grant purge): pg_trigger_depth() > 1;
--   * explicit, named maintenance in one transaction: SET LOCAL nasi.audit_maintenance = 'on' (tests that backdate rows).
-- Idempotent: safe to run more than once.
CREATE OR REPLACE FUNCTION nasi_append_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF coalesce(current_setting('nasi.audit_maintenance', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nasi_retention_purge')
     AND pg_has_role(current_user, 'nasi_retention_purge', 'USAGE')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY_AUDIT_TABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['security_audit_events', 'usage_meter_events', 'break_glass_access_log', 'operator_mfa_log',
                           'retention_purge_runs', 'customer_release_authorizations', 'platform_production_authorizations',
                           'production_deploy_decisions']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nasi_append_only_guard()',
                     t || '_append_only', t);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION nasi_append_only_guard() FROM PUBLIC;
