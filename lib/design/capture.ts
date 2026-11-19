import { SUMMARY_FIELD_KEYS, type SummaryFieldKey } from "@/lib/design/summary-fields";

/**
 * Deterministic capture of the design chat (owner rule 2026-11-19: no AI output is stored as a requirement).
 * The customer's own messages are assigned to summary areas by a fixed rule, word for word:
 *   1st customer message           -> original description (the app idea, in full)
 *   2nd .. 7th customer messages   -> problem_statement, users_personas, must_have_features, out_of_scope,
 *                                     constraints, open_questions (in that order; the assistant is told to ask
 *                                     about exactly this area next)
 *   every later customer message   -> decisions and notes, each kept with the assistant message it answered
 *   after a "Version N started" marker (Revise, DC-03) every customer message is a change request (decisions).
 * Withdrawn messages are skipped; edited messages count with their current text. Same messages -> same capture.
 */
export const VERSION_MARKER = /^Version \d+ started\. /;

export type CaptureRow = { role: string; content: string; is_ai_draft?: boolean; withdrawn_at?: unknown };
export type ChatDecision = { text: string; in_reply_to: string | null };
export type ChatCapture = {
  original_description: string | null;
  answers: Record<SummaryFieldKey, string | null>;
  decisions: ChatDecision[];
  /** What the assistant must ask about next: an area key, "original_description", or "decisions". */
  next_focus: SummaryFieldKey | "original_description" | "decisions";
};

export function captureFromMessages(rows: CaptureRow[]): ChatCapture {
  const answers = Object.fromEntries(SUMMARY_FIELD_KEYS.map((k) => [k, null])) as Record<SummaryFieldKey, string | null>;
  let original: string | null = null;
  const decisions: ChatDecision[] = [];
  let slot = 0; // 0 = original description, 1..6 = SUMMARY_FIELD_KEYS, 7+ = decisions
  let revising = false;
  let lastAssistant: string | null = null;
  for (const m of rows) {
    if (m.withdrawn_at) continue;
    const text = (m.content ?? "").trim();
    if (m.role === "assistant") {
      if (m.is_ai_draft === false && VERSION_MARKER.test(text)) revising = true;
      lastAssistant = text || lastAssistant;
      continue;
    }
    if (m.role !== "customer" || !text) continue;
    if (revising || slot > SUMMARY_FIELD_KEYS.length) {
      decisions.push({ text, in_reply_to: lastAssistant });
    } else if (slot === 0) {
      original = text;
      slot = 1;
    } else {
      answers[SUMMARY_FIELD_KEYS[slot - 1]] = text;
      slot += 1;
    }
  }
  const next_focus = revising || slot > SUMMARY_FIELD_KEYS.length ? "decisions" : slot === 0 ? "original_description" : SUMMARY_FIELD_KEYS[slot - 1];
  return { original_description: original, answers, decisions, next_focus };
}

/** Fixed question for each area, so the assistant's question always matches where the answer will be stored. */
export const FOCUS_QUESTION: Record<ChatCapture["next_focus"], string> = {
  original_description: "Tell me what you are trying to build, in your own words.",
  problem_statement: "What problem should the app solve? What goes wrong today, and for whom?",
  users_personas: "Who will use the app or benefit from it, and what does each of them do with it?",
  must_have_features: "What must the app do? List the must-have features, one per line if you can.",
  out_of_scope: "What should the app NOT do, or leave for later?",
  constraints: "What limits should the design respect: timeline, budget, tools or technology, team, privacy or legal?",
  open_questions: "What questions or uncertainties do you still have?",
  decisions: "Is there anything you want to decide, change or add? Each answer is kept word for word as a decision or note.",
};
