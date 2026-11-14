import {
  emptySummaryFields,
  type SummaryFieldKey,
  type SummaryFields,
} from "@/lib/design/summary-fields";
import type { FieldProposals } from "@/lib/design/summary-extract";

/** DIR §2.2: AI may propose; never auto-fill customer_confirmed. */
export function applyAiProposals(
  fields: SummaryFields,
  proposals: FieldProposals,
): SummaryFields {
  const next = { ...fields };
  for (const key of Object.keys(proposals) as SummaryFieldKey[]) {
    const text = proposals[key]?.trim();
    if (!text) continue;
    if (next[key]?.customer_confirmed?.trim()) continue;
    next[key] = {
      ai_proposed: text,
      customer_confirmed: next[key]?.customer_confirmed ?? null,
    };
  }
  return next;
}

export function ensureSummaryShape(raw: SummaryFields | null | undefined): SummaryFields {
  const base = emptySummaryFields();
  if (!raw) return base;
  for (const key of Object.keys(base) as SummaryFieldKey[]) {
    base[key] = {
      ai_proposed: raw[key]?.ai_proposed ?? null,
      customer_confirmed: raw[key]?.customer_confirmed ?? null,
    };
  }
  return base;
}
