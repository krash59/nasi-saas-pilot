import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ approve: vi.fn(), generate: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/design/repository", () => ({
  approveDesignSummary: mocks.approve,
  getProjectForCustomer: mocks.project,
  confirmSummaryField: vi.fn(), getOrCreateSummary: vi.fn(), getProjectStageInfo: vi.fn(),
}));
vi.mock("@/lib/design/dir-repository", () => ({ generateDirDraft: mocks.generate }));
const ix = vi.hoisted(() => ({ value: { mode: "legacy", view: null } as { mode: string; view: unknown } }));
vi.mock("@/lib/intake/repository", () => ({ withIntake: async () => ix.value, intakeModeTx: vi.fn() }));
import { POST } from "@/app/api/projects/[projectId]/design/summary/route";
const ctx = { params: Promise.resolve({ projectId: "project" }) };
const request = () => new Request("http://localhost/summary", { method: "POST", body: JSON.stringify({ action: "approve" }) });
describe("Customer summary approval produces DIR draft", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.project.mockResolvedValue({ id: "project" }); mocks.approve.mockResolvedValue({ status: "approved" }); });
  it("generates only after successful customer approval", async () => {
    mocks.generate.mockResolvedValue({ status: "AI_DRAFT" });
    expect(await (await POST(request(), ctx)).json()).toEqual({ status: "approved", draft: { status: "AI_DRAFT" } });
    expect(mocks.approve.mock.invocationCallOrder[0]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]);
  });
  it("does not generate when confirmation gate rejects approval", async () => {
    mocks.approve.mockRejectedValue(new Error("FIELDS_NOT_CONFIRMED"));
    expect((await POST(request(), ctx)).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("intake v3: approval is refused while the deterministic gate has issues", async () => {
    const { projectIntake } = await import("@/lib/intake/project");
    ix.value = { mode: "v3", view: projectIntake([]) };
    const r = await POST(request(), ctx);
    ix.value = { mode: "legacy", view: null };
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("INTAKE_GATE_FAILED");
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("reports durable approval with recoverable generation failure", async () => {
    mocks.generate.mockRejectedValue(new Error("storage unavailable"));
    expect(await (await POST(request(), ctx)).json()).toEqual({ status: "approved", dir_error: "DIR_GENERATION_FAILED_RETRY" });
  });
});
