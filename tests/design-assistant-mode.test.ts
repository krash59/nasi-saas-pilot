import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateDesignAssistantReply,
  getDesignAssistantMode,
} from "@/lib/design/openai";
import { emptySummaryFields } from "@/lib/design/summary-fields";

describe("design assistant provider mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the deterministic assistant only when explicitly enabled in development", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "stub");
    vi.stubEnv("OPENAI_API_KEY", "");

    const result = await generateDesignAssistantReply(
      [{ role: "customer", content: "A fictional bakery site" }],
      { fieldsSnapshot: emptySummaryFields() },
    );

    expect(getDesignAssistantMode()).toBe("local_stub");
    expect(result.isAiDraft).toBe(true);
    expect(result.proposals.problem_statement).toContain("fictional bakery");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the local stub outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "stub");

    expect(() => getDesignAssistantMode()).toThrow("LOCAL_STUB_MODE_REQUIRES_DEVELOPMENT");
    await expect(generateDesignAssistantReply([])).rejects.toThrow(
      "LOCAL_STUB_MODE_REQUIRES_DEVELOPMENT",
    );
  });

  it("keeps OpenAI as the default and fails clearly without its key", async () => {
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    expect(getDesignAssistantMode()).toBe("openai");
    await expect(generateDesignAssistantReply([])).rejects.toThrow(
      "OPENAI_API_KEY not configured",
    );
  });
});
