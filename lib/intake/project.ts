import { QUESTIONS, QUESTION_IDS, questionById } from "@/lib/intake/protocol";
import { SUMMARY_FIELD_KEYS, type SummaryFieldKey } from "@/lib/design/summary-fields";

/**
 * Pure, deterministic projection of the intake event log (design v3 R1, R3, R8-R14, R19).
 * state = fold(events ordered by seq). No clock, no randomness, no AI, no I/O: the same events always give the same result.
 */
export type IntakeEventType =
  | "AnswerGiven" | "NextPressed" | "FieldMarkedNone" | "AnswerAmended" | "AnswerWithdrawn" | "MessageMoved"
  | "AnswerReplaced" | "SectionConfirmed" | "OpenQuestionStatusSet" | "DecisionRecorded";

/** Canonical event: only these fields count (audit timestamps are excluded, R19 / owner D3). */
export type IntakeEvent = {
  seq: number;
  event_type: IntakeEventType;
  question_id?: string | null;
  message_id?: string | null;
  item_id?: string | null;
  verbatim_text?: string | null;
  status?: string | null;
};

/** source = "e<seq>" of the event that captured the text (deterministic, R19); message_id lets the UI move/edit it. */
export type Answer = { source: string; text: string; message_id: string | null };
export type QuestionView = {
  id: string; heading: string; field: SummaryFieldKey | null; text: string;
  state: "answered" | "none" | "empty";
  answers: Answer[];
  confirmation: "confirmed" | "unconfirmed" | "needs_recheck";
};
export type OpenItem = {
  item_id: string; text: string; source: string;
  status: "UNSET" | "OPEN" | "SETTLED" | "NEEDS_RECHECK";
  note: string | null; decision: string | null;
};
export type GateIssue = { code: "FIELD_EMPTY" | "UNCONFIRMED_SECTION" | "NEEDS_RECHECK" | "QUESTION_STATUS_MISSING"; ref: string };
export type IntakeView = {
  active_question_id: string | null;
  questions: QuestionView[];
  open_items: OpenItem[];
  gate: { pass: boolean; issues: GateIssue[] };
};

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** Deterministic split of an answer into items: bullet lines if any, else non-empty lines. Text kept verbatim. */
export function splitItems(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => BULLET.test(l));
  return (bullets.length ? bullets.map((l) => l.replace(BULLET, "").trim()) : lines).filter(Boolean);
}

export function projectIntake(input: readonly IntakeEvent[]): IntakeView {
  const events = [...input].sort((a, b) => a.seq - b.seq);
  let cursor = 0;
  const bound = new Map<string, { question: string; text: string; seq: number }>(); // message_id -> binding
  const replaced = new Map<string, { source: string; text: string; seq: number }>(); // question -> customer rewrite
  const none = new Map<string, number>(); // question -> seq marked None
  const lastChange = new Map<string, number>();
  const lastConfirm = new Map<string, number>();
  const status = new Map<string, { status: "OPEN" | "SETTLED"; note: string | null; seq: number }>();
  const decision = new Map<string, { text: string; seq: number }>();
  const touch = (q: string | undefined, seq: number) => { if (q) lastChange.set(q, seq); };
  const advance = (q: string) => { if (QUESTION_IDS[cursor] === q) cursor += 1; };

  for (const e of events) {
    const q = e.question_id ?? undefined;
    switch (e.event_type) {
      case "AnswerGiven":
        if (q && questionById(q) && e.message_id && e.verbatim_text) {
          bound.set(e.message_id, { question: q, text: e.verbatim_text, seq: e.seq });
          none.delete(q); touch(q, e.seq);
        }
        break;
      case "AnswerAmended": {
        const b = e.message_id ? bound.get(e.message_id) : undefined;
        if (b && e.verbatim_text) { b.text = e.verbatim_text; touch(b.question, e.seq); }
        break;
      }
      case "AnswerWithdrawn": {
        const b = e.message_id ? bound.get(e.message_id) : undefined;
        if (b && e.message_id) { bound.delete(e.message_id); touch(b.question, e.seq); }
        break;
      }
      case "MessageMoved": {
        const b = e.message_id ? bound.get(e.message_id) : undefined;
        if (b && q && questionById(q) && q !== b.question) { touch(b.question, e.seq); b.question = q; none.delete(q); touch(q, e.seq); }
        break;
      }
      case "AnswerReplaced":
        if (q && questionById(q) && e.verbatim_text) {
          replaced.set(q, { source: `e${e.seq}`, text: e.verbatim_text, seq: e.seq });
          none.delete(q); touch(q, e.seq);
        }
        break;
      case "FieldMarkedNone":
        if (q && questionById(q)) { none.set(q, e.seq); touch(q, e.seq); advance(q); }
        break;
      case "NextPressed":
        if (q) advance(q);
        break;
      case "SectionConfirmed":
        if (q && questionById(q)) lastConfirm.set(q, e.seq);
        break;
      case "OpenQuestionStatusSet":
        if (e.item_id && (e.status === "OPEN" || e.status === "SETTLED")) status.set(e.item_id, { status: e.status, note: e.verbatim_text ?? null, seq: e.seq });
        break;
      case "DecisionRecorded":
        if (e.item_id && e.verbatim_text) decision.set(e.item_id, { text: e.verbatim_text, seq: e.seq });
        break;
    }
  }

  const answersFor = (q: string): Answer[] => {
    const r = replaced.get(q);
    // A customer rewrite (check-answers "Change") supersedes answers bound before it; later chat answers are added after it.
    const chat = [...bound.entries()].filter(([, b]) => b.question === q && (!r || b.seq > r.seq))
      .sort((a, b) => a[1].seq - b[1].seq).map(([id, b]) => ({ source: `e${b.seq}`, text: b.text, message_id: id }));
    return r ? [{ source: r.source, text: r.text, message_id: null }, ...chat] : chat;
  };

  const questions: QuestionView[] = QUESTIONS.map((qq) => {
    const answers = answersFor(qq.id);
    const state = answers.length ? "answered" : none.has(qq.id) ? "none" : "empty";
    const conf = lastConfirm.get(qq.id), chg = lastChange.get(qq.id) ?? 0;
    const confirmation = conf === undefined ? "unconfirmed" : conf > chg ? "confirmed" : "needs_recheck";
    return { id: qq.id, heading: qq.heading, field: qq.field, text: qq.text, state, answers, confirmation };
  });

  const oq = questions.find((x) => x.id === "q11_open_questions")!;
  const oqChanged = lastChange.get("q11_open_questions") ?? 0;
  const open_items: OpenItem[] = oq.answers.flatMap((a) => splitItems(a.text).map((text, i) => {
    const item_id = `${a.source}:${i}`;
    const s = status.get(item_id), d = decision.get(item_id);
    let st: OpenItem["status"] = s ? s.status : "UNSET";
    if (st === "SETTLED" && !d) st = "UNSET";
    if (s && s.seq < oqChanged) st = "NEEDS_RECHECK";
    return { item_id, text, source: a.source, status: st, note: s?.note ?? null, decision: d && st === "SETTLED" ? d.text : null };
  }));

  const issues: GateIssue[] = [];
  for (const x of questions) {
    if (questionById(x.id)!.required && x.state === "empty") issues.push({ code: "FIELD_EMPTY", ref: x.id });
    else if (x.confirmation === "needs_recheck") issues.push({ code: "NEEDS_RECHECK", ref: x.id });
    else if (x.confirmation === "unconfirmed") issues.push({ code: "UNCONFIRMED_SECTION", ref: x.id });
  }
  for (const it of open_items) {
    if (it.status === "UNSET") issues.push({ code: "QUESTION_STATUS_MISSING", ref: it.item_id });
    if (it.status === "NEEDS_RECHECK") issues.push({ code: "NEEDS_RECHECK", ref: it.item_id });
  }
  return { active_question_id: QUESTION_IDS[cursor] ?? null, questions, open_items, gate: { pass: issues.length === 0, issues } };
}

const NONE_TEXT = "None (stated by the customer).";
const body = (x: QuestionView) => (x.state === "none" ? NONE_TEXT : x.answers.map((a) => a.text).join("\n\n"));

/** Deterministic template: the six Design Summary fields, built only from the customer's words and fixed strings. */
export function renderSummaryFields(view: IntakeView): Record<SummaryFieldKey, string> {
  const out = {} as Record<SummaryFieldKey, string>;
  for (const key of SUMMARY_FIELD_KEYS) {
    if (key === "open_questions") {
      // Lossless (owner rule; found 2026-11-20 when a table and headings were dropped): the field is the customer's FULL
      // answer word for word, then a fixed-template status line per item. The item split only drives the status list.
      const q = view.questions.find((x) => x.id === "q11_open_questions")!;
      if (q.state === "none") { out[key] = NONE_TEXT; continue; }
      const status = (i: OpenItem) => i.status === "SETTLED" ? "settled (see Decisions)"
        : i.status === "OPEN" ? `still open${i.note ? ` (customer: ${i.note})` : ""}` : "status not set";
      out[key] = `${body(q)}\n\nStatus set by the customer:\n${view.open_items.map((i) => `- ${i.text}: ${status(i)}`).join("\n")}`;
      continue;
    }
    const qs = view.questions.filter((x) => x.field === key);
    out[key] = qs.length === 1 ? body(qs[0]) : qs.map((x) => `${x.heading}:\n${body(x)}`).join("\n\n");
  }
  return out;
}

/** Extra DIR sections (fixed templates, customer's words only) with provenance (R11, R13, R15). */
export function renderDirExtras(view: IntakeView): { key: string; title: string; content: string; sources: string[] }[] {
  const orig = view.questions.find((x) => x.id === "q01_original_description")!;
  const settled = view.open_items.filter((i) => i.status === "SETTLED");
  const out = [{ key: "original_description", title: "Original description (customer's own words)", content: body(orig), sources: orig.answers.map((a) => a.source) }];
  if (settled.length) {
    out.push({
      key: "decisions", title: "Decisions (customer's own words)",
      content: settled.map((i, n) => `${n + 1}. Question: ${i.text}\n   Decision: ${i.decision}\n   Status: accepted; decided by the customer`).join("\n\n"),
      sources: settled.map((i) => i.item_id),
    });
  }
  return out;
}
