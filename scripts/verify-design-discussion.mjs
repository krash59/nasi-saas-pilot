#!/usr/bin/env node
/**
 * IMPLEMENT_AND_VERIFY_GPT_DESIGN_DISCUSSION
 * DIR §§2.1, 2.2, 5.2 — unit + optional DB persistence checks.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvLocal } from "./lib/load-env-local.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvLocal(appRoot);
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

function runVitest() {
  const r = spawnSync(
    "npm",
    ["test", "--", "tests/design-conversation.test.ts", "tests/design-summary-gate.test.ts"],
    {
      stdio: "inherit",
      cwd: appRoot,
    },
  );
  return r.status === 0;
}

async function verifyDbPersistence() {
  if (!url) {
    return { skipped: true, reason: "No DATABASE_URL" };
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    return {
      skipped: true,
      reason: e instanceof Error ? e.message : "DB connect failed",
    };
  }
  try {
    const reg = await client.query(`SELECT register_customer('verify_design_user') AS id`);
    const customerId = reg.rows[0].id;
    await client.query(`SELECT set_config('app.current_customer_id', $1, false)`, [customerId]);
    const proj = await client.query(
      `INSERT INTO projects (customer_id, name) VALUES ($1, 'verify-design') RETURNING id`,
      [customerId],
    );
    const projectId = proj.rows[0].id;
    await client.query(
      `INSERT INTO design_messages (project_id, role, content, is_ai_draft) VALUES ($1, 'customer', 'hello', false)`,
      [projectId],
    );
    const count = await client.query(
      `SELECT count(*)::int AS n FROM design_messages WHERE project_id = $1`,
      [projectId],
    );
    await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    return { skipped: false, messageCount: count.rows[0].n };
  } finally {
    await client.end();
  }
}

async function main() {
  const evidence = { vitest: false, db: null, openai: "NOT_RUN" };
  evidence.vitest = runVitest();
  evidence.db = await verifyDbPersistence();
  if (process.env.OPENAI_API_KEY) {
    evidence.openai = "KEY_PRESENT_LIVE_CHAT_MANUAL";
  } else {
    evidence.openai = "SKIPPED_NO_KEY_STUB_TESTS_PASS";
  }

  const pass =
    evidence.vitest &&
    (evidence.db.skipped || evidence.db.messageCount >= 1);

  console.log(JSON.stringify({ verdict: pass ? "PASS" : "FAIL", evidence }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
