import { describe, expect, it } from "vitest";
import { captureFromMessages, FOCUS_QUESTION, type CaptureRow } from "@/lib/design/capture";
import { buildDirDraft, chatSections } from "@/lib/design/dir-draft";
import { storiesFromDir } from "@/lib/design/stories";
import { SUMMARY_FIELD_KEYS, emptySummaryFields } from "@/lib/design/summary-fields";

/** Owner rule 2026-11-19: capture is deterministic and stores only the customer's own words (no AI output). */
const A = (content: string, is_ai_draft = true): CaptureRow => ({ role: "assistant", content, is_ai_draft });
const C = (content: string, withdrawn_at: unknown = null): CaptureRow => ({ role: "customer", content, withdrawn_at });
const IDEA = "We are a growing online shop. We want triage help for support email.\nTech: Python FastAPI, OpenAI or Claude.";
const MUST = "There are three must-haves:\n* **Classification:** detect topic, urgency and language\n* **Routing:** alert Slack on urgent tickets\n* **Draft replies:** saved as an internal note, never auto-sent\nTogether these remove the prep work.";
const chat: CaptureRow[] = [
  A("Welcome", false), C(IDEA),
  A("Thanks. What problem should the app solve?"), C("Agents spend too long reading and tagging tickets."),
  A("Who will use it?"), C("Support agents (daily) and team leads (alerts, weekly trends)."),
  A("What must it do?"), C(MUST),
  A("What should it not do?"), C("* No auto-sending\n* No refunds or order edits"),
  A("Limits?"), C("Prototype in 2-3 weeks; ticket data must not train public models."),
  A("Open questions?"), C("Should drafts use live order status?"),
  A("Phase 1 could draft from the message text only."), C("Agreed: message-only drafting in Phase 1, cheap model for tagging."),
];

describe("deterministic design chat capture", () => {
  it("assigns the customer's own messages to fixed areas, word for word", () => {
    const c = captureFromMessages(chat);
    expect(c.original_description).toBe(IDEA);
    expect(c.answers.problem_statement).toBe("Agents spend too long reading and tagging tickets.");
    expect(c.answers.must_have_features).toBe(MUST);
    expect(c.answers.open_questions).toBe("Should drafts use live order status?");
    expect(c.decisions).toEqual([{ text: "Agreed: message-only drafting in Phase 1, cheap model for tagging.", in_reply_to: "Phase 1 could draft from the message text only." }]);
    expect(c.next_focus).toBe("decisions");
  });

  it("never stores assistant text as an answer", () => {
    const c = captureFromMessages(chat);
    const stored = [c.original_description, ...Object.values(c.answers), ...c.decisions.map((d) => d.text)].join("\n");
    for (const m of chat.filter((r) => r.role === "assistant")) expect(stored).not.toContain(m.content);
  });

  it("same messages always give the same capture", () => {
    const runs = Array.from({ length: 5 }, () => JSON.stringify(captureFromMessages(structuredClone(chat))));
    expect(new Set(runs).size).toBe(1);
  });

  it("skips withdrawn messages and walks the areas in a fixed order", () => {
    const rows = [A("Welcome", false), C("idea"), C("typo", "2026-11-19T00:00:00Z"), C("the problem")];
    const c = captureFromMessages(rows);
    expect(c.original_description).toBe("idea");
    expect(c.answers.problem_statement).toBe("the problem");
    expect(c.next_focus).toBe("users_personas");
    expect(captureFromMessages([A("Welcome", false)]).next_focus).toBe("original_description");
    expect(Object.keys(FOCUS_QUESTION)).toEqual(["original_description", ...SUMMARY_FIELD_KEYS, "decisions"]);
  });

  it("after Revise every customer message is a change request", () => {
    const rows = [...chat, A("Version 2 started. Version 1 is saved and will not change. Tell me what you want to change.", false), C("Add Telegram alerts too.")];
    const c = captureFromMessages(rows);
    expect(c.decisions.at(-1)?.text).toBe("Add Telegram alerts too.");
    expect(c.answers.must_have_features).toBe(MUST);
  });
});

describe("deterministic DIR and stories from the customer's words", () => {
  const approved = () => {
    const fields = emptySummaryFields();
    const c = captureFromMessages(chat);
    for (const k of SUMMARY_FIELD_KEYS) fields[k].customer_confirmed = c.answers[k];
    return { status: "approved", approved_at: "2026-11-19T00:00:00Z", fields };
  };

  it("DIR keeps the original description and the decisions word for word", () => {
    const dir = buildDirDraft(approved(), captureFromMessages(chat));
    const byKey = Object.fromEntries(dir.sections.map((s) => [s.key, s.content]));
    expect(byKey.original_description).toBe(IDEA);
    expect(byKey.chat_decisions).toContain("Agreed: message-only drafting in Phase 1, cheap model for tagging.");
    expect(byKey.must_have_features).toBe(MUST);
    expect(JSON.stringify(buildDirDraft(approved(), captureFromMessages(chat)))).toBe(JSON.stringify(dir));
    expect(chatSections(null)).toEqual([]);
  });

  it("only bullet lines become stories when the customer used bullets", () => {
    const stories = storiesFromDir(buildDirDraft(approved(), captureFromMessages(chat)));
    expect(stories).toHaveLength(3);
    expect(JSON.stringify(stories)).not.toContain("**");
    expect(JSON.stringify(stories)).not.toContain("Together these remove");
  });
});
