#!/usr/bin/env node
import { loadEnvLocal } from "./lib/load-env-local.mjs";
import { runMigrationFile, withPg } from "./lib/pg-migrate.mjs";

loadEnvLocal();

const url = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error(
    "Missing DATABASE_URL.\n" +
      "  1. cp .env.example .env.local\n" +
      "  2. Set DATABASE_URL (Neon connection string, or local Postgres)\n" +
      "  3. npm run db:migrate\n" +
      "Next.js dev loads .env.local automatically; this script now does too.",
  );
  process.exit(1);
}

await withPg(url, async (client) => {
  const fs = await import("fs");
  const path = await import("path");
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    console.log("Applying", file);
    await runMigrationFile(client, path.join("db", "migrations", file));
  }
  console.log("Done.");
});
