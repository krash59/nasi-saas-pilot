import { describe, expect, it } from "vitest";
import { projectIntake, renderDirExtras, renderSummaryFields, splitItems, type IntakeEvent } from "@/lib/intake/project";
import { QUESTION_IDS, isBareNegative } from "@/lib/intake/protocol";

/** Design v3 smoke spec (nasi_v1/docs/DESIGN_CAPTURE_SMOKE_SPEC.md): deterministic projection of the intake event log. */
let seq = 0;
const ev = (e: Omit<IntakeEvent, "seq">): IntakeEvent => ({ seq: ++seq, ...e });
const answer = (q: string, id: string, text: string) => ev({ event_type: "AnswerGiven", question_id: q, message_id: id, verbatim_text: text });
const next = (q: string) => ev({ event_type: "NextPressed", question_id: q });
const confirm = (q: string) => ev({ event_type: "SectionConfirmed", question_id: q });

const IDEA = "We are a growing online shop.\nTech: Python FastAPI, OpenAI or Claude. Slack and helpdesk integration.";
const MUST = "Five must-haves:\n* **Classification:** topic, urgency, language, sentiment, order numbers\n* Routing with Slack alerts\nTogether these remove prep work.";
function walkthrough(): IntakeEvent[] {
  seq = 0;
  const t: Record<string, string> = {
    q01_original_description: IDEA, q02_problem: "Agents spend too long reading and tagging tickets.",
    q03_users: "Support agents (daily) and team leads (alerts, weekly trends).", q04_must_haves: MUST,
    q05_out_of_scope: "* No auto-sending\n* No refunds or order edits", q06_tech_stack: "Python (FastAPI); OpenAI or Claude.",
    q07_integrations: "Helpdesk, Slack or Telegram, Google Sheets.", q08_data: "Log timestamp, category, urgency, sentiment.",
    q09_privacy: "Ticket data must not train public models.", q10_limits: "Prototype in 2-3 weeks; milestone delivery.",
    q11_open_questions: "* Should drafts use live order status?\n* One model or two?",
  };
  const out: IntakeEvent[] = [];
  QUESTION_IDS.forEach((q, i) => { out.push(answer(q, `m${i + 1}`, t[q])); out.push(next(q)); });
  return out;
}
function settledAndConfirmed(): IntakeEvent[] {
  const evs = walkthrough();
  const items = projectIntake(evs).open_items;
  for (const it of items) {
    evs.push(ev({ event_type: "OpenQuestionStatusSet", item_id: it.item_id, status: "SETTLED" }));
    evs.push(ev({ event_type: "DecisionRecorded", item_id: it.item_id, verbatim_text: `Decided: ${it.text}` }));
  }
  for (const q of QUESTION_IDS) evs.push(confirm(q));
  return evs;
}

describe("intake projection (deterministic)", () => {
  it("C01: every answer is kept word for word under the question it answered; specifics survive into the record", () => {
    const v = projectIntake(walkthrough());
    expect(v.questions.find((q) => q.id === "q04_must_haves")!.answers[0].text).toBe(MUST);
    const f = renderSummaryFields(v);
    expect(f.must_have_features).toBe(MUST);
    expect(f.constraints).toContain("Technology:\nPython (FastAPI); OpenAI or Claude.");
    expect(f.constraints).toContain("Privacy and security:\nTicket data must not train public models.");
    expect(renderDirExtras(v)[0].content).toBe(IDEA);
    expect(v.active_question_id).toBeNull();
  });

  it("C02: settled questions leave Open questions and appear as decisions in the customer's words", () => {
    const v = projectIntake(settledAndConfirmed());
    expect(v.gate).toEqual({ pass: true, issues: [] });
    expect(renderSummaryFields(v).open_questions).toMatch(/^None open/);
    const dec = renderDirExtras(v).find((s) => s.key === "decisions")!;
    expect(dec.content).toContain("Decision: Decided: Should drafts use live order status?");
  });

  it("C03: an open question with no status blocks the gate", () => {
    const evs = walkthrough(); for (const q of QUESTION_IDS) evs.push(confirm(q));
    const v = projectIntake(evs);
    expect(v.gate.issues.filter((i) => i.code === "QUESTION_STATUS_MISSING")).toHaveLength(2);
  });

  it("SETTLED without a recorded decision does not count as settled", () => {
    const evs = walkthrough(); const it0 = projectIntake(evs).open_items[0];
    evs.push(ev({ event_type: "OpenQuestionStatusSet", item_id: it0.item_id, status: "SETTLED" }));
    expect(projectIntake(evs).open_items[0].status).toBe("UNSET");
  });

  it("C05/R3: binding follows the active question, not message count; extra messages never shift another field", () => {
    seq = 0;
    const evs = [answer("q01_original_description", "a", "idea"), answer("q01_original_description", "b", "more idea"),
      next("q01_original_description"), answer("q02_problem", "c", "the problem")];
    const v = projectIntake(evs);
    expect(v.questions[0].answers.map((a) => a.text)).toEqual(["idea", "more idea"]);
    expect(v.questions[1].answers.map((a) => a.text)).toEqual(["the problem"]);
    expect(v.active_question_id).toBe("q02_problem");
    evs.push(ev({ event_type: "MessageMoved", message_id: "c", question_id: "q03_users" }));
    const w = projectIntake(evs);
    expect(w.questions[1].state).toBe("empty");
    expect(w.questions[2].answers[0].text).toBe("the problem");
  });

  it("C08/C09: editing or withdrawing a confirmed answer marks it NEEDS_RECHECK; withdrawn text disappears", () => {
    const evs = settledAndConfirmed();
    evs.push(ev({ event_type: "AnswerAmended", message_id: "m2", verbatim_text: "Agents waste hours." }));
    let v = projectIntake(evs);
    expect(v.questions[1].confirmation).toBe("needs_recheck");
    expect(v.gate.issues).toContainEqual({ code: "NEEDS_RECHECK", ref: "q02_problem" });
    evs.push(confirm("q02_problem"));
    expect(projectIntake(evs).gate.pass).toBe(true);
    evs.push(ev({ event_type: "AnswerWithdrawn", message_id: "m3" }));
    v = projectIntake(evs);
    expect(JSON.stringify(renderSummaryFields(v))).not.toContain("Support agents (daily)");
    expect(v.gate.issues).toContainEqual({ code: "FIELD_EMPTY", ref: "q03_users" });
  });

  it("C10/C11: bare negatives are not answers; explicit None is a stated value; empty blocks the gate", () => {
    expect(["no", "N/A", "none.", "Nothing!"].every(isBareNegative)).toBe(true);
    expect(isBareNegative("No refunds in v1")).toBe(false);
    seq = 0;
    const v = projectIntake([ev({ event_type: "FieldMarkedNone", question_id: "q01_original_description" })]);
    expect(v.questions[0].state).toBe("none");
    expect(v.active_question_id).toBe("q02_problem");
    expect(renderDirExtras(v)[0].content).toBe("None (stated by the customer).");
    expect(v.gate.issues).toContainEqual({ code: "FIELD_EMPTY", ref: "q02_problem" });
  });

  it("check-answers Change replaces the earlier answers with the customer's rewrite", () => {
    const evs = walkthrough();
    evs.push(ev({ event_type: "AnswerReplaced", question_id: "q02_problem", verbatim_text: "Rewritten by me." }));
    expect(renderSummaryFields(projectIntake(evs)).problem_statement).toBe("Rewritten by me.");
  });

  it("C14/I1: same events always give byte-identical output, whatever order they are passed in", () => {
    const evs = settledAndConfirmed();
    const ref = JSON.stringify([projectIntake(evs), renderSummaryFields(projectIntake(evs)), renderDirExtras(projectIntake(evs))]);
    let s = 20261119; // fixed seed: deterministic shuffles
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let r = 0; r < 25; r++) {
      const shuffled = [...evs].sort(() => rnd() - 0.5);
      expect(JSON.stringify([projectIntake(shuffled), renderSummaryFields(projectIntake(shuffled)), renderDirExtras(projectIntake(shuffled))])).toBe(ref);
    }
  });

  it("I2: every stored field is customer text or a fixed template string", () => {
    const v = projectIntake(settledAndConfirmed());
    const customer = settledAndConfirmed().map((e) => e.verbatim_text).filter(Boolean).join("\n");
    for (const value of Object.values(renderSummaryFields(v))) {
      const residue = value.split("\n").map((l) => l.replace(/^(- |  Open because \(customer\): )/, "").replace(/^[A-Za-z ,]+:$/, "").trim())
        .filter((l) => l && !customer.includes(l) && !/^None open\.|^None \(stated/.test(l));
      expect(residue).toEqual([]);
    }
  });

  it("splitItems keeps bullet lines verbatim and drops intro/outro sentences", () => {
    expect(splitItems(MUST)).toEqual(["**Classification:** topic, urgency, language, sentiment, order numbers", "Routing with Slack alerts"]);
    expect(splitItems("one\ntwo")).toEqual(["one", "two"]);
  });
});
