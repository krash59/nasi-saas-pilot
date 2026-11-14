import { describe, expect, it } from "vitest";
import { allRequiredFieldsConfirmed, emptySummaryFields } from "@/lib/design/summary-fields";
import { denyAgenticWithoutApprovedSummary } from "@/lib/design/stage-gate";

describe("BDD_F04_01 Design Summary gate", () => {
  it("denies agentic authorization when summary not approved", () => {
    expect(
      denyAgenticWithoutApprovedSummary({
        lifecycle_stage: "design_discussion",
        summary_status: "draft",
      }),
    ).toBe(true);
  });

  it("allows gate check pass when summary approved (implementation still separate)", () => {
    expect(
      denyAgenticWithoutApprovedSummary({
        lifecycle_stage: "design_summary_review",
        summary_status: "approved",
      }),
    ).toBe(false);
  });

  it("requires all DIR §2.2 fields confirmed before approval", () => {
    const f = emptySummaryFields();
    expect(allRequiredFieldsConfirmed(f)).toBe(false);
    f.problem_statement.customer_confirmed = "x";
    expect(allRequiredFieldsConfirmed(f)).toBe(false);
  });
});
