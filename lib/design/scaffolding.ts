import {
  SUMMARY_FIELD_KEYS,
  type SummaryFieldKey,
  type SummaryFields,
} from "@/lib/design/summary-fields";

export const SCAFFOLD_LABELS: Record<SummaryFieldKey, string> = {
  problem_statement: "the problem you are solving",
  users_personas: "who will use the app",
  must_have_features: "must-have features",
  out_of_scope: "what is out of scope",
  constraints: "budget, time, or compliance constraints",
  open_questions: "open questions we still need to answer",
};

export const WELCOME_MESSAGE = `Welcome to your design workspace.

We will shape your app idea step by step — like a guided interview, not a technical quiz.
Tell me what you are trying to build in your own words. I will ask one focused question at a time.

Nothing I suggest is final until you confirm it on the Design Summary page.`;

/** Next DIR §2.2 area to guide (TurboTax-style), skipping customer-confirmed fields. */
export function getNextScaffoldFocus(fields: SummaryFields | null | undefined): SummaryFieldKey {
  const f = fields ?? ({} as SummaryFields);
  for (const key of SUMMARY_FIELD_KEYS) {
    const confirmed = f[key]?.customer_confirmed?.trim();
    if (!confirmed) return key;
  }
  return "open_questions";
}

export function buildScaffoldPromptAugment(
  focus: SummaryFieldKey,
  fields: SummaryFields | null | undefined,
): string {
  const label = SCAFFOLD_LABELS[focus];
  const confirmed = SUMMARY_FIELD_KEYS.filter((k) => fields?.[k]?.customer_confirmed?.trim());
  return [
    `Current focus: help the customer clarify ${label}.`,
    confirmed.length
      ? `Already confirmed by customer (do not treat as approved again): ${confirmed.join(", ")}.`
      : "No summary fields confirmed yet.",
    "Ask at most one clear question in your visible reply.",
  ].join("\n");
}
