import { SUMMARY_FIELD_KEYS, type SummaryFieldKey } from "@/lib/design/summary-fields";

const START = "<!--DESIGN_FIELDS-->";
const END = "<!--END_DESIGN_FIELDS-->";

export type FieldProposals = Partial<Record<SummaryFieldKey, string>>;

/** Parse optional structured draft fields from model output (DIR §2.2 ai_proposed). */
export function extractFieldProposals(raw: string): {
  visibleContent: string;
  proposals: FieldProposals;
} {
  const start = raw.indexOf(START);
  if (start === -1) {
    return { visibleContent: raw.trim(), proposals: {} };
  }
  const end = raw.indexOf(END, start);
  const jsonSlice =
    end === -1 ? raw.slice(start + START.length) : raw.slice(start + START.length, end);
  const visibleContent = (
    raw.slice(0, start) + (end === -1 ? "" : raw.slice(end + END.length))
  ).trim();

  let proposals: FieldProposals = {};
  try {
    const parsed = JSON.parse(jsonSlice.trim()) as Record<string, unknown>;
    for (const key of SUMMARY_FIELD_KEYS) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim()) proposals[key] = v.trim();
    }
  } catch {
    proposals = {};
  }
  return { visibleContent: visibleContent || raw.trim(), proposals };
}

export const DESIGN_FIELDS_INSTRUCTION = `
After your customer-facing reply, append a machine block (not shown to customer in UI if parsed):
${START}
{"problem_statement":"optional draft text","users_personas":null}
${END}
Include only keys where you have new or updated draft text. Use null for unchanged keys.`;
