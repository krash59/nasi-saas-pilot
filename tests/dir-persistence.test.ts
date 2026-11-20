import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { emptySummaryFields, SUMMARY_FIELD_KEYS } from "@/lib/design/summary-fields";

const state = vi.hoisted(() => ({ client: null as pg.Client | null, customerId: "", actor: "dir-test" }));
vi.mock("@/lib/tenant/customer", () => ({ requireCustomer: async () => ({ id: state.customerId, clerk_user_id: state.actor }) }));
vi.mock("@/lib/db/client", () => ({
  getSql: () => async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return (await state.client!.query(query, values)).rows;
  },
  withCustomerContext: async (sql: unknown, id: string, fn: (tx: unknown) => unknown) => {
    await state.client!.query("SELECT set_config('app.current_customer_id', $1, true)", [id]);
    return fn(sql);
  },
}));
import { generateDirDraft, getDirDraft, approveDirDraft } from "@/lib/design/dir-repository";

// Explicit opt-in: migrations/fixtures/role changes all roll back in one connection.
const url = process.env.DIR_TEST_DATABASE_URL;
describe.skipIf(!url)("DIR persistence and RLS (real PostgreSQL)", () => {
  let connected = false;
  const a = randomUUID(), b = randomUUID(), project = randomUUID();
  const role = `dir_verify_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    state.client = new pg.Client({ connectionString: url, connectionTimeoutMillis:5000 });
    await state.client.connect();
    connected = true;
    await state.client.query("BEGIN");
    for (const file of ["001_init_tenant_rls.sql", "002_design_conversation_summary.sql", "003_dir_drafts.sql", "004_customer_dir_approval.sql"]) {
      await state.client.query(readFileSync(`db/migrations/${file}`, "utf8"));
    }
    await state.client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await state.client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await state.client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON projects, design_summaries, dir_drafts TO ${role}`);
    await state.client.query(`GRANT SELECT ON intake_events TO ${role}`); // v3: the DIR reads the customer's intake log
    await state.client.query("INSERT INTO customers(id, clerk_user_id) VALUES ($1,$3),($2,$4)", [a,b,`dir-a-${a}`,`dir-b-${b}`]);
    await state.client.query("SELECT set_config('app.current_customer_id', $1, true)", [a]);
    await state.client.query("INSERT INTO projects(id,customer_id,name) VALUES ($1,$2,'DIR verification')", [project,a]);
    const fields = emptySummaryFields();
    for (const key of SUMMARY_FIELD_KEYS) fields[key] = { customer_confirmed: key, ai_proposed: "EXCLUDED" };
    await state.client.query("INSERT INTO design_summaries(project_id,fields) VALUES($1,$2)", [project, JSON.stringify(fields)]);
    await state.client.query(`SET LOCAL ROLE ${role}`);
    state.customerId = a;
  });
  afterAll(async () => { if (state.client && connected) { try { await state.client.query("ROLLBACK"); } finally { await state.client.end(); } } });
  it("gates, persists, retries, advances stage, and denies another tenant", async () => {
    await expect(approveDirDraft(project, {})).rejects.toThrow("DIR_REVIEW_MISMATCH_OR_MISSING");
    await expect(generateDirDraft(project)).rejects.toThrow("DESIGN_SUMMARY_NOT_APPROVED");
    await state.client!.query("UPDATE design_summaries SET status='approved', approved_at=now() WHERE project_id=$1", [project]);
    const first = await generateDirDraft(project);
    expect(first.status).toBe("AI_DRAFT");
    expect(JSON.stringify(first.content)).not.toContain("EXCLUDED");
    expect((await generateDirDraft(project)).created_at).toEqual(first.created_at);
    expect(await getDirDraft(project)).toEqual(first);
    const stage = await state.client!.query("SELECT lifecycle_stage FROM projects WHERE id=$1", [project]);
    expect(stage.rows[0].lifecycle_stage).toBe("dir");
    await expect(approveDirDraft(project, { altered: true })).rejects.toThrow("DIR_REVIEW_MISMATCH_OR_MISSING");
    const approved = await approveDirDraft(project, first.content);
    expect(approved.status).toBe("approved");
    expect(approved.approved_by).toBe(state.actor);
    expect(approved.approved_at).toBeTruthy();
    expect((await approveDirDraft(project, first.content)).approved_at).toEqual(approved.approved_at);
    expect((await generateDirDraft(project)).status).toBe("approved");
    expect((await state.client!.query("SELECT lifecycle_stage FROM projects WHERE id=$1", [project])).rows[0].lifecycle_stage).toBe("agile_bdd");
    state.customerId = b;
    await expect(approveDirDraft(project, first.content)).rejects.toThrow("DIR_REVIEW_MISMATCH_OR_MISSING");
    expect(await getDirDraft(project)).toBeNull();
    await expect(generateDirDraft(project)).rejects.toThrow("DESIGN_SUMMARY_NOT_APPROVED");
    expect((await state.client!.query("SELECT * FROM dir_drafts")).rows).toHaveLength(0);
    expect((await state.client!.query("UPDATE dir_drafts SET generated_by='intruder' WHERE project_id=$1", [project])).rowCount).toBe(0);
  });
});
