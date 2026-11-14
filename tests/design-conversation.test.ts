import { describe, expect, it } from "vitest";
import { WELCOME_MESSAGE, getNextScaffoldFocus } from "@/lib/design/scaffolding";
import { emptySummaryFields } from "@/lib/design/summary-fields";
import { extractFieldProposals } from "@/lib/design/summary-extract";
import { applyAiProposals } from "@/lib/design/merge-proposals";
import { generateDesignAssistantReplyStub } from "@/lib/design/openai";

describe("BDD_F03_01 In-dashboard GPT design talk", () => {
  it("seeds guided welcome scaffolding for a new project", () => {
    expect(WELCOME_MESSAGE).toMatch(/step by step/i);
    expect(WELCOME_MESSAGE).toMatch(/Design Summary/i);
  });

  it("adapts scaffold focus to first unconfirmed summary field", () => {
    const fields = emptySummaryFields();
    fields.problem_statement.customer_confirmed = "Track volunteer hours";
    expect(getNextScaffoldFocus(fields)).toBe("users_personas");
  });

  it("strips machine block from visible assistant content", () => {
    const raw = `What problem are you solving?
<!--DESIGN_FIELDS-->
{"problem_statement":"Help nonprofits track hours"}
<!--END_DESIGN_FIELDS-->`;
    const { visibleContent, proposals } = extractFieldProposals(raw);
    expect(visibleContent).not.toContain("DESIGN_FIELDS");
    expect(proposals.problem_statement).toContain("nonprofits");
  });

  it("stub reply produces AI_DRAFT proposals for offline verification", () => {
    const out = generateDesignAssistantReplyStub(
      [{ role: "customer", content: "I need a volunteer tracker" }],
      { fieldsSnapshot: emptySummaryFields() },
    );
    expect(out.isAiDraft).toBe(true);
    expect(out.proposals.problem_statement).toBeTruthy();
  });
});

describe("BDD_F03_02 AI draft vs customer confirmation", () => {
  it("stores AI proposals only in ai_proposed until customer confirms", () => {
    const base = emptySummaryFields();
    const merged = applyAiProposals(base, {
      problem_statement: "Draft from GPT",
      must_have_features: "Login and reports",
    });
    expect(merged.problem_statement.ai_proposed).toBe("Draft from GPT");
    expect(merged.problem_statement.customer_confirmed).toBeNull();
    expect(merged.must_have_features.customer_confirmed).toBeNull();
  });

  it("does not overwrite customer_confirmed when AI proposes again", () => {
    const base = emptySummaryFields();
    base.problem_statement.customer_confirmed = "My exact words";
    base.problem_statement.ai_proposed = "Old draft";
    const merged = applyAiProposals(base, { problem_statement: "New AI text" });
    expect(merged.problem_statement.customer_confirmed).toBe("My exact words");
    expect(merged.problem_statement.ai_proposed).toBe("Old draft");
  });
});
