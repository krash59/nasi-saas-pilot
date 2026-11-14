#!/usr/bin/env node
/**
 * Real-DB cross-tenant isolation check (BDD_F05_01).
 * Uses DATABASE_URL or TEST_DATABASE_URL (Neon or any PostgreSQL 14+).
 */
import pg from "pg";
import { runMigrationFile, withPg } from "./lib/pg-migrate.mjs";

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("MISSING_DATABASE_URL");
  process.exit(2);
}

const APP_USER = "app_user_wave1";
const APP_PASS = "app_pass_wave1_test";

async function ensureAppRole(admin) {
  await admin.query(`DROP ROLE IF EXISTS ${APP_USER}`);
  await admin.query(
    `CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOBYPASSRLS`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_USER}`);
  await admin.query(`GRANT EXECUTE ON FUNCTION register_customer(TEXT) TO ${APP_USER}`);
  await admin.query(`GRANT SELECT ON customers TO ${APP_USER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO ${APP_USER}`);
}

async function main() {
  const evidence = { crossTenant: {}, migration: {} };

  await withPg(url, async (admin) => {
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrationFile(admin, "db/migrations/001_init_tenant_rls.sql");
    evidence.migration.applied = "001_init_tenant_rls.sql";
    await ensureAppRole(admin);

    const a = await admin.query(`SELECT register_customer('clerk_user_a') AS id`);
    const b = await admin.query(`SELECT register_customer('clerk_user_b') AS id`);
    const idA = a.rows[0].id;
    const idB = b.rows[0].id;

    await admin.query(`SELECT set_config('app.current_customer_id', $1, true)`, [idA]);
    await admin.query(`INSERT INTO projects (customer_id, name) VALUES ($1, 'project-a')`, [
      idA,
    ]);
    await admin.query(`SELECT set_config('app.current_customer_id', $1, true)`, [idB]);
    await admin.query(`INSERT INTO projects (customer_id, name) VALUES ($1, 'project-b')`, [
      idB,
    ]);
  });

  const appUrl = replaceUserInUrl(url, APP_USER, APP_PASS);
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();

  const aRow = await app.query(`SELECT register_customer('clerk_user_a') AS id`);
  const bRow = await app.query(`SELECT register_customer('clerk_user_b') AS id`);
  const idA = aRow.rows[0].id;
  const idB = bRow.rows[0].id;

  await app.query(`SELECT set_config('app.current_customer_id', $1, false)`, [idA]);
  const asA = await app.query(`SELECT name FROM projects ORDER BY name`);
  await app.query(`SELECT set_config('app.current_customer_id', $1, false)`, [idA]);
  const leak = await app.query(`SELECT name FROM projects WHERE customer_id = $1`, [idB]);

  await app.query(`SELECT set_config('app.current_customer_id', $1, false)`, [idB]);
  const asB = await app.query(`SELECT name FROM projects ORDER BY name`);

  await app.end();

  evidence.crossTenant.asCustomerA = asA.rows.map((r) => r.name);
  evidence.crossTenant.asCustomerB = asB.rows.map((r) => r.name);
  evidence.crossTenant.crossReadCount = leak.rows.length;

  const pass =
    evidence.crossTenant.asCustomerA.length === 1 &&
    evidence.crossTenant.asCustomerA[0] === "project-a" &&
    evidence.crossTenant.asCustomerB.length === 1 &&
    evidence.crossTenant.asCustomerB[0] === "project-b" &&
    evidence.crossTenant.crossReadCount === 0;

  console.log(JSON.stringify({ pass, evidence }, null, 2));
  process.exit(pass ? 0 : 1);
}

function replaceUserInUrl(connectionString, user, password) {
  const u = new URL(connectionString);
  u.username = user;
  u.password = password;
  return u.toString();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
