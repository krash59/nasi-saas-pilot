import { afterEach, describe, expect, it, vi } from "vitest";
import { draftSummaryFromConversation, generateDesignAssistantReply, parseDesignTurn, proposalsFromFields } from "@/lib/design/openai";
import { emptySummaryFields } from "@/lib/design/summary-fields";

/** Owner walkthrough 2026-11-19: the Design Summary only filled 2 of 6 areas because the model could skip the hidden field block. */
function okResponse(content: string, total = 123) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: total } }), { status: 200 });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Design Summary fill (structured model output)", () => {
  it("reads every area from a structured turn and shows only the reply", () => {
    const raw = JSON.stringify({ reply: "What must it do?", fields: { problem_statement: "Slow triage", users_personas: "Agents", must_have_features: "Auto tagging", out_of_scope: "Auto send", constraints: "3 weeks", open_questions: null } });
    const t = parseDesignTurn(raw);
    expect(t.visibleContent).toBe("What must it do?");
    expect(Object.keys(t.proposals).sort()).toEqual(["constraints", "must_have_features", "out_of_scope", "problem_statement", "users_personas"]);
  });

  it("falls back to the older hidden-block format when the reply is not JSON", () => {
    const t = parseDesignTurn('Hi\n<!--DESIGN_FIELDS-->\n{"constraints":"Budget"}\n<!--END_DESIGN_FIELDS-->');
    expect(t.visibleContent).toBe("Hi");
    expect(t.proposals).toEqual({ constraints: "Budget" });
  });

  it("drops unknown keys, nulls and blanks", () => {
    expect(proposalsFromFields({ problem_statement: "  x ", hack: "y", constraints: "", open_questions: null })).toEqual({ problem_statement: "x" });
  });

  it("chat turns ask the model for a strict schema covering all six areas", async () => {
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetch = vi.fn().mockResolvedValue(okResponse(JSON.stringify({ reply: "Next?", fields: { problem_statement: null, users_personas: null, must_have_features: "Booking", out_of_scope: null, constraints: null, open_questions: null } })));
    vi.stubGlobal("fetch", fetch);
    const out = await generateDesignAssistantReply([{ role: "customer", content: "Booking is a must" }], { fieldsSnapshot: emptySummaryFields() });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.fields.required).toHaveLength(6);
    expect(out.content).toBe("Next?");
    expect(out.proposals).toEqual({ must_have_features: "Booking" });
    expect(out.tokensUsed).toBe(123);
  });

  it("fill from chat drafts from the whole conversation and meters tokens", async () => {
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetch = vi.fn().mockResolvedValue(okResponse(JSON.stringify({ problem_statement: "P", users_personas: "U", must_have_features: "M", out_of_scope: "O", constraints: "C", open_questions: "Q" }), 456));
    vi.stubGlobal("fetch", fetch);
    const out = await draftSummaryFromConversation([
      { role: "customer", content: "first message" },
      { role: "assistant", content: "question" },
      { role: "customer", content: "last message" },
    ]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const transcript = body.messages[1].content as string;
    expect(transcript).toContain("first message");
    expect(transcript).toContain("last message");
    expect(body.response_format.json_schema.schema.required).toHaveLength(6);
    expect(Object.keys(out.proposals)).toHaveLength(6);
    expect(out.tokensUsed).toBe(456);
  });

  it("fill from chat makes no paid call when the customer has said nothing", async () => {
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await draftSummaryFromConversation([{ role: "assistant", content: "Welcome" }])).toEqual({ proposals: {}, tokensUsed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fill from chat fails closed without a key", async () => {
    vi.stubEnv("NASI_DESIGN_ASSISTANT_MODE", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(draftSummaryFromConversation([{ role: "customer", content: "x" }])).rejects.toThrow("OPENAI_API_KEY not configured");
  });
});
