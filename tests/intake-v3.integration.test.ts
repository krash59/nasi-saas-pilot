import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
// Design v3 deterministic intake on real PostgreSQL (disposable nasi_audit only), app runtime role with RLS.
// Smoke spec: nasi_v1/docs/DESIGN_CAPTURE_SMOKE_SPEC.md (C01-C16, I1-I4).
const identity = vi.hoisted(() => ({ id: "00000000-0000-4000-8000-000000000001", clerk_user_id: "test_a" }));
vi.mock("@/lib/tenant/customer", () => ({ requireCustomer: async () => ({ ...identity }) }));
import { POST as intakePost, GET as intakeGet } from "@/app/api/projects/[projectId]/intake/route";
import { POST as messagePost, PATCH as messagePatch } from "@/app/api/projects/[projectId]/design/messages/route";
import { POST as summaryPost } from "@/app/api/projects/[projectId]/design/summary/route";
import { getDirDraft } from "@/lib/design/dir-repository";
import { QUESTIONS } from "@/lib/intake/protocol";
import { closePgPools } from "@/lib/db/pg-sql";
import { reviseDesign, listDesignVersions } from "@/lib/design/versions";

const url = process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-000000000021", P2 = "00000000-0000-4000-8000-000000000022";
const ctx = (p: string) => ({ params: Promise.resolve({ projectId: p }) });
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const ANSWERS: Record<string, string> = {
  q01_original_description: "We are a growing online shop.\nTech: Python FastAPI, OpenAI or Claude. Slack and helpdesk.",
  q02_problem: "Agents spend too long reading and tagging tickets.", q03_users: "Support agents and team leads.",
  q04_must_haves: "Must-haves:\n* Classify topic, urgency, language\n* Alert Slack on urgent tickets\nThat is all.",
  q05_out_of_scope: "* No auto-sending\n* No refunds", q06_tech_stack: "Python (FastAPI)", q07_integrations: "Helpdesk, Slack, Google Sheets",
  q08_data: "Log timestamp, category, urgency, sentiment", q09_privacy: "Ticket data must not train public models",
  q10_limits: "Prototype in 2-3 weeks", q11_open_questions: "* Live order status?\n* One model or two?",
};

async function intake(p: string, body: unknown) {
  const r = await intakePost(post(body), ctx(p));
  return { status: r.status, json: await r.json() };
}
async function walk(p: string) {
  for (const q of QUESTIONS) {
    const r = await messagePost(post({ message: ANSWERS[q.id], question_id: q.id }), ctx(p));
    expect(r.status).toBe(200);
    expect((await intake(p, { action: "next", question_id: q.id })).status).toBe(200);
  }
  const v = (await intake(p, { action: "confirm", question_id: "q01_original_description" })).json.view;
  for (const it of v.open_items) expect((await intake(p, { action: "settle", item_id: it.item_id, decision: `We decided: ${it.text}` })).status).toBe(200);
  for (const q of QUESTIONS) await intake(p, { action: "confirm", question_id: q.id });
}

describe.skipIf(!url)("Intake v3 (real PostgreSQL, app role, RLS)", () => {
  let admin: Client; let app: Client; const oldUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    const parsed = new URL(url!); if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/nasi_audit") throw new Error("ISOLATED_LOCAL_DB_REQUIRED");
    admin = new Client({ connectionString: url }); await admin.connect();
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS intake_app");
    for (const f of readdirSync(resolve("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) await admin.query(readFileSync(resolve("db/migrations", f), "utf8"));
    // 019 itself must be safe to re-run (the full runner is not: an older migration fails on re-run).
    await admin.query(readFileSync(resolve("db/migrations/019_intake_events.sql"), "utf8"));
    await admin.query("CREATE ROLE intake_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
    const u = new URL(url!); u.username = "intake_app"; u.password = "local_audit_only"; process.env.DATABASE_URL = u.toString();
    app = new Client({ connectionString: u.toString() }); await app.connect();
  });
  beforeEach(async () => {
    identity.id = A; identity.clerk_user_id = "test_a";
    await admin.query("TRUNCATE customers CASCADE");
    await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')", [A, B]);
    await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'Support triage'),($3,$2,'Support triage copy')", [P1, A, P2]);
  });
  afterAll(async () => { await closePgPools(); await app?.end(); await admin?.end(); if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl; });

  it("C01/C02: full flow through the real routes; DIR carries every answer word for word plus decisions", async () => {
    await walk(P1);
    const ap = await summaryPost(post({ action: "approve" }), ctx(P1));
    expect(ap.status).toBe(200);
    const dir = await getDirDraft(P1) as { content: { sections: { key: string; content: string }[] } };
    const by = Object.fromEntries(dir.content.sections.map((s) => [s.key, s.content]));
    expect(by.original_description).toBe(ANSWERS.q01_original_description);
    expect(by.must_have_features).toBe(ANSWERS.q04_must_haves);
    expect(by.constraints).toContain("Privacy and security:\nTicket data must not train public models");
    expect(by.open_questions.startsWith(ANSWERS.q11_open_questions)).toBe(true);
    expect(by.open_questions).toContain("Live order status?: settled (see Decisions)");
    expect(by.decisions).toContain("Decision: We decided: Live order status?");
    const ev = await admin.query("SELECT DISTINCT actor FROM intake_events");
    expect(ev.rows).toEqual([{ actor: "customer" }]);
  });

  it("C14/I1: two projects with the same inputs give byte-identical DIR content", async () => {
    await walk(P1); await walk(P2);
    await summaryPost(post({ action: "approve" }), ctx(P1)); await summaryPost(post({ action: "approve" }), ctx(P2));
    const d1 = await getDirDraft(P1) as { content: unknown }, d2 = await getDirDraft(P2) as { content: unknown };
    expect(JSON.stringify(d2.content)).toBe(JSON.stringify(d1.content));
  });

  it("C03/C11: approval is refused until the gate passes", async () => {
    const r = await summaryPost(post({ action: "approve" }), ctx(P1));
    expect(r.status).toBe(409);
    expect((await r.json()).issues.map((i: { code: string }) => i.code)).toContain("FIELD_EMPTY");
  });

  it("C05: a message is refused if the question changed since the customer saw it; never re-bound", async () => {
    await messagePost(post({ message: "idea", question_id: "q01_original_description" }), ctx(P1));
    await intake(P1, { action: "next", question_id: "q01_original_description" });
    const r = await messagePost(post({ message: "late text", question_id: "q01_original_description" }), ctx(P1));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("QUESTION_CHANGED_RELOAD");
    const n = await admin.query("SELECT count(*)::int AS n FROM design_messages WHERE content='late text'");
    expect(n.rows[0].n).toBe(0);
  });

  it("C08: editing a confirmed answer makes it NEEDS_RECHECK (one transaction with the edit)", async () => {
    await walk(P1);
    const m = await admin.query("SELECT message_id FROM intake_events WHERE project_id=$1 AND question_id='q02_problem' AND event_type='AnswerGiven'", [P1]);
    const r = await messagePatch(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ action: "edit", messageId: m.rows[0].message_id, content: "Agents waste hours." }) }), ctx(P1));
    expect(r.status).toBe(200);
    const v = await (await intakeGet(new Request("http://localhost/x"), ctx(P1))).json();
    expect(v.view.questions.find((q: { id: string }) => q.id === "q02_problem").confirmation).toBe("needs_recheck");
    expect(v.view.gate.issues).toContainEqual({ code: "NEEDS_RECHECK", ref: "q02_problem" });
  });

  it("C10: bare negatives are refused; None is explicit", async () => {
    const r = await messagePost(post({ message: "n/a", question_id: "q01_original_description" }), ctx(P1));
    expect(r.status).toBe(400);
    expect((await intake(P1, { action: "none", question_id: "q01_original_description" })).json.view.questions[0].state).toBe("none");
  });

  it("I1/R1: the event log is append-only for the app role (UPDATE, DELETE, TRUNCATE refused)", async () => {
    await messagePost(post({ message: "idea", question_id: "q01_original_description" }), ctx(P1));
    await app.query("BEGIN"); await app.query("SELECT set_config('app.current_customer_id',$1,true)", [A]);
    await expect(app.query("UPDATE intake_events SET verbatim_text='x'")).rejects.toThrow();
    await app.query("ROLLBACK"); await app.query("BEGIN"); await app.query("SELECT set_config('app.current_customer_id',$1,true)", [A]);
    await expect(app.query("DELETE FROM intake_events")).rejects.toThrow();
    await app.query("ROLLBACK");
    await expect(app.query("TRUNCATE intake_events")).rejects.toThrow();
    await expect(admin.query("UPDATE intake_events SET verbatim_text='x'")).rejects.toThrow(/APPEND_ONLY/);
  });

  it("C15/RLS: another tenant cannot read or write this project's intake", async () => {
    await messagePost(post({ message: "idea", question_id: "q01_original_description" }), ctx(P1));
    identity.id = B; identity.clerk_user_id = "test_b";
    expect((await intakeGet(new Request("http://localhost/x"), ctx(P1))).status).toBe(404);
    expect((await intake(P1, { action: "none", question_id: "q02_problem" })).status).toBe(404);
    await app.query("BEGIN"); await app.query("SELECT set_config('app.current_customer_id',$1,true)", [B]);
    expect((await app.query("SELECT count(*)::int AS n FROM intake_events")).rows[0].n).toBe(0);
    await app.query("ROLLBACK");
  });

  it("C12: version 2 change is stored against that question; version 1 stays unchanged; DIR v2 shows the change", async () => {
    await walk(P1);
    expect((await summaryPost(post({ action: "approve" }), ctx(P1))).status).toBe(200);
    await reviseDesign(P1);
    const ch = await intake(P1, { action: "change", question_id: "q04_must_haves", text: "* Classify topic\n* Alert Slack\n* Weekly report" });
    expect(ch.status).toBe(200);
    expect(ch.json.view.questions.find((q: { id: string }) => q.id === "q04_must_haves").confirmation).toBe("needs_recheck");
    const ev = await admin.query("SELECT event_type, question_id FROM intake_events WHERE project_id=$1 ORDER BY seq DESC LIMIT 1", [P1]);
    expect(ev.rows[0]).toEqual({ event_type: "AnswerReplaced", question_id: "q04_must_haves" });
    expect((await summaryPost(post({ action: "approve" }), ctx(P1))).status).toBe(409);
    await intake(P1, { action: "confirm", question_id: "q04_must_haves" });
    expect((await summaryPost(post({ action: "approve" }), ctx(P1))).status).toBe(200);
    const v2 = await getDirDraft(P1) as { content: { sections: { key: string; content: string }[] } };
    expect(v2.content.sections.find((s) => s.key === "must_have_features")!.content).toContain("Weekly report");
    const archived = (await listDesignVersions(P1)).versions as unknown as { version: number; dir: unknown }[];
    const v1 = archived.find((x) => x.version === 1)!;
    expect(JSON.stringify(v1.dir)).not.toContain("Weekly report");
    expect(JSON.stringify(v1.dir)).toContain("Alert Slack on urgent tickets");
  });

  it("C13: a message over 8,000 characters is refused at send; nothing is stored or cut", async () => {
    const r = await messagePost(post({ message: "x".repeat(8001), question_id: "q01_original_description" }), ctx(P1));
    expect(r.status).toBe(400);
    const n = await admin.query("SELECT count(*)::int AS n FROM design_messages WHERE project_id=$1 AND role='customer'", [P1]);
    expect(n.rows[0].n).toBe(0);
    expect((await intake(P1, { action: "change", question_id: "q02_problem", text: "y".repeat(8001) })).status).toBe(400);
  });
});
