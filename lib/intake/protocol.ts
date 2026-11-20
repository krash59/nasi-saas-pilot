import type { SummaryFieldKey } from "@/lib/design/summary-fields";

/**
 * Fixed, versioned question protocol (design v3 R2). Deterministic: the app asks these questions in this order, with this
 * exact text; no AI writes or chooses a question. Each answer is bound to the question that was active when it arrived (R3).
 */
export const PROTOCOL_VERSION = "nasi-intake-1";

export type Question = {
  id: string;
  /** Summary field the answer feeds; null = kept as its own DIR section (original description). */
  field: SummaryFieldKey | null;
  /** Sub-heading inside the field (constraints are split into fixed sub-questions so specifics are never dropped). */
  heading: string;
  text: string;
  required: boolean;
};

export const QUESTIONS: readonly Question[] = [
  { id: "q01_original_description", field: null, heading: "Original description", required: true,
    text: "Tell me what you are trying to build, in your own words. Include anything you already know." },
  { id: "q02_problem", field: "problem_statement", heading: "Problem", required: true,
    text: "What problem should the app solve? What goes wrong today, and for whom?" },
  { id: "q03_users", field: "users_personas", heading: "Users", required: true,
    text: "Who will use the app or benefit from it, and what does each of them do with it?" },
  { id: "q04_must_haves", field: "must_have_features", heading: "Must-have features", required: true,
    text: "What must the app do? List the must-have features, one per line if you can." },
  { id: "q05_out_of_scope", field: "out_of_scope", heading: "Out of scope", required: true,
    text: "What should the app NOT do, or leave for later?" },
  { id: "q06_tech_stack", field: "constraints", heading: "Technology", required: true,
    text: "Do you need particular technology (languages, platforms, AI providers, hosting)?" },
  { id: "q07_integrations", field: "constraints", heading: "Integrations", required: true,
    text: "Which other tools or systems must the app connect to (for example email, helpdesk, chat, spreadsheets, payments)?" },
  { id: "q08_data", field: "constraints", heading: "Data", required: true,
    text: "What information must the app record or show (for example fields, logs, reports)?" },
  { id: "q09_privacy", field: "constraints", heading: "Privacy and security", required: true,
    text: "What privacy, security or legal rules must the app follow?" },
  { id: "q10_limits", field: "constraints", heading: "Timeline, budget and team", required: true,
    text: "What limits apply: timeline, budget, who will maintain it, how it is delivered?" },
  { id: "q11_open_questions", field: "open_questions", heading: "Open questions", required: true,
    text: "What questions or uncertainties do you still have? Put each on its own line." },
] as const;

export const QUESTION_IDS = QUESTIONS.map((q) => q.id);
export const questionById = (id: string) => QUESTIONS.find((q) => q.id === id) ?? null;

/** Fixed acknowledgement after each customer message (no AI). */
export const ACK_TEXT = "Saved word for word. Add more if you like, or press \"Next question\" when this answer is complete.";
export const DONE_TEXT = "That was the last question. Open the Design Summary page to check your answers, settle your open questions and confirm each section.";

/** R9 (owner D4): a bare negative is not an answer; the customer uses the explicit None button instead. Fixed list. */
export const BARE_NEGATIVES = new Set(["no", "n/a", "na", "none", "nothing", "nope", "not applicable", "-", "nil"]);
export const isBareNegative = (text: string) => BARE_NEGATIVES.has(text.trim().toLowerCase().replace(/[.!]+$/, ""));
