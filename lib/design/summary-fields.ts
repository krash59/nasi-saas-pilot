/** DIR §2.2 conversation → Design Summary fields */
export const SUMMARY_FIELD_KEYS = [
  "problem_statement",
  "users_personas",
  "must_have_features",
  "out_of_scope",
  "constraints",
  "open_questions",
] as const;

export type SummaryFieldKey = (typeof SUMMARY_FIELD_KEYS)[number];

export type SummaryFieldValue = {
  ai_proposed: string | null;
  customer_confirmed: string | null;
};

export type SummaryFields = Record<SummaryFieldKey, SummaryFieldValue>;

export function emptySummaryFields(): SummaryFields {
  return Object.fromEntries(
    SUMMARY_FIELD_KEYS.map((k) => [k, { ai_proposed: null, customer_confirmed: null }]),
  ) as SummaryFields;
}

export function allRequiredFieldsConfirmed(fields: SummaryFields): boolean {
  return SUMMARY_FIELD_KEYS.every((k) => {
    const v = fields[k]?.customer_confirmed?.trim();
    return Boolean(v && v.length > 0);
  });
}
