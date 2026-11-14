import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildDirDraft } from "@/lib/design/dir-draft";
import { emptySummaryFields, SUMMARY_FIELD_KEYS } from "@/lib/design/summary-fields";

function approved() {
  const fields = emptySummaryFields();
  for (const key of SUMMARY_FIELD_KEYS) fields[key] = { customer_confirmed: `Customer ${key}`, ai_proposed: "UNCONFIRMED secret" };
  return { fields, status: "approved", approved_at: "2026-11-02T00:00:00Z" };
}

describe("Design Summary → DIR contract (§2.2, §5.2)", () => {
  it("preserves all six confirmed fields and excludes AI proposals", () => {
    const result = buildDirDraft(approved());
    expect(result.sections.map(s => s.key)).toEqual(SUMMARY_FIELD_KEYS);
    expect(JSON.stringify(result)).not.toContain("UNCONFIRMED");
    expect(result.status).toBe("AI_DRAFT");
    expect(result.governance).toContain("does not approve this DIR");
    expect(result.sections[0].content).toBe("Customer problem_statement");
  });
  it.each(["draft", "ready_for_review"])("blocks %s summary", status => {
    expect(() => buildDirDraft({ ...approved(), status })).toThrow("DESIGN_SUMMARY_NOT_APPROVED");
  });
  it("requires approval evidence and complete confirmation", () => {
    expect(() => buildDirDraft({ ...approved(), approved_at: null })).toThrow("DESIGN_SUMMARY_NOT_APPROVED");
    const summary = approved();
    summary.fields.constraints.customer_confirmed = " ";
    expect(() => buildDirDraft(summary)).toThrow("FIELDS_NOT_CONFIRMED");
  });
});

const mocks = vi.hoisted(() => ({ project: vi.fn(), generate: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/design/repository", () => ({ getProjectForCustomer: mocks.project }));
vi.mock("@/lib/design/dir-repository", () => ({ generateDirDraft: mocks.generate, getDirDraft: mocks.read }));
import { GET, POST } from "@/app/api/projects/[projectId]/dir/route";
const ctx = { params: Promise.resolve({ projectId: "00000000-0000-4000-8000-000000000001" }) };
const req = new Request("http://localhost/api/dir");

describe("DIR HTTP boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.project.mockResolvedValue({ id: "owned" }); });
  it("denies cross-tenant reads and generation before repository access", async () => {
    mocks.project.mockResolvedValue(null);
    expect((await GET(req, ctx)).status).toBe(404);
    expect((await POST(req, ctx)).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects malformed project identifiers", async () => {
    expect((await POST(req, { params: Promise.resolve({ projectId: "bad" }) })).status).toBe(404);
    expect(mocks.project).not.toHaveBeenCalled();
  });
  it("fails closed for unapproved summaries", async () => {
    mocks.generate.mockRejectedValue(new Error("DESIGN_SUMMARY_NOT_APPROVED"));
    expect((await POST(req, ctx)).status).toBe(409);
  });
  it("returns saved draft and retrieves it without generating again", async () => {
    const draft = { content: buildDirDraft(approved()) };
    mocks.generate.mockResolvedValue(draft);
    mocks.read.mockResolvedValue(draft);
    expect(await (await POST(req, ctx)).json()).toEqual({ draft });
    expect(await (await GET(req, ctx)).json()).toEqual({ draft });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("does not disclose database failures", async () => {
    mocks.generate.mockRejectedValue(new Error("secret connection details"));
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "DIR_REQUEST_FAILED" });
  });
});
