#!/usr/bin/env node
/**
 * COMPLETE_AND_VERIFY_DIR_DRAFT_GENERATION — unit + PostgreSQL integration.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./lib/load-env-local.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvLocal(appRoot);

const dbUrl =
  process.env.DIR_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL;

function runTests(patterns) {
  const r = spawnSync("npm", ["test", "--", ...patterns], {
    stdio: "inherit",
    cwd: appRoot,
    env: { ...process.env, DIR_TEST_DATABASE_URL: dbUrl ?? "" },
  });
  return r.status === 0;
}

const unitOk = runTests([
  "tests/dir-draft.test.ts",
  "tests/dir-approval.test.ts",
  "tests/summary-dir-workflow.test.ts",
]);

if (!unitOk) process.exit(1);

if (!dbUrl) {
  console.log(
    JSON.stringify({
      verdict: "PARTIAL",
      reason: "Set DIR_TEST_DATABASE_URL or DATABASE_URL for PostgreSQL integration",
      unit: "PASS",
    }),
  );
  process.exit(2);
}

const dbOk = runTests(["tests/dir-persistence.test.ts"]);
console.log(
  JSON.stringify({
    verdict: dbOk ? "PASS" : "FAIL",
    unit: "PASS",
    postgres: dbOk ? "PASS" : "FAIL",
    migration: "001–004 migrations (via test fixture)",
  }),
);
process.exit(dbOk ? 0 : 1);
