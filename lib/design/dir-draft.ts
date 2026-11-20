import { allRequiredFieldsConfirmed, SUMMARY_FIELD_KEYS, type SummaryFields } from "./summary-fields";

export const DIR_LABELS = ["Problem statement", "Users / personas", "Must-have features", "Out of scope", "Constraints", "Open questions"];

/** Deterministic draft: no model call and no inferred requirements. */
export type DirSection = { key: string; title: string; content: string; sources?: string[] };

/** extras: fixed-template sections built from the customer's own words (intake v3: original description, decisions). */
export function buildDirDraft(summary: { status: string; approved_at: unknown; fields: SummaryFields }, extras: DirSection[] = []) {
  if (summary.status !== "approved" || !summary.approved_at) throw new Error("DESIGN_SUMMARY_NOT_APPROVED");
  if (!allRequiredFieldsConfirmed(summary.fields)) throw new Error("FIELDS_NOT_CONFIRMED");
  return {
    status: "AI_DRAFT" as const,
    sections: [
      ...SUMMARY_FIELD_KEYS.map((key, i): DirSection => ({
        key, title: DIR_LABELS[i], content: summary.fields[key].customer_confirmed!,
      })),
      ...extras,
    ],
    governance: "Draft for customer review. Design Summary approval does not approve this DIR or authorize implementation, deployment, billing, or NWS/GAS canonical changes.",
  };
}

export type DirDraftContent = ReturnType<typeof buildDirDraft>;
