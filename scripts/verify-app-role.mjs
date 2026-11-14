// Fails if the app's runtime DATABASE_URL logs in as a superuser or a BYPASSRLS role.
// Prints role attributes only; never prints the connection string.
import pg from "pg";
import { loadEnvLocal } from "./lib/load-env-local.mjs";

loadEnvLocal();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("APP_ROLE_CHECK=BLOCKED reason=DATABASE_URL_BLANK");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(
    "SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const r = rows[0];
  const ok = r && !r.rolsuper && !r.rolbypassrls;
  console.log(`APP_ROLE_CHECK=${ok ? "PASS" : "FAIL"} role=${r?.role} superuser=${r?.rolsuper} bypassrls=${r?.rolbypassrls}`);
  process.exit(ok ? 0 : 1);
} finally {
  await client.end();
}
