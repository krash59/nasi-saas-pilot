import { describe, expect, it } from "vitest";
import { storiesFromDir } from "@/lib/design/stories";

// DC-02 (owner walkthrough 2026-11-17): stories must not be template fill-ins of whole DIR fields.
const dir = (fields: Record<string, string>) => ({ sections: Object.entries(fields).map(([key, content]) => ({ key, content })) });
const clinic = dir({
  problem_statement: "Patients cannot book appointments outside office hours. Receptionists spend hours on the phone rescheduling. Dentists see no-shows because nobody sends reminders.",
  users_personas: "Patient: books and cancels visits\nReceptionist - manages the daily schedule\nDentist (reviews the day's appointments)",
  must_have_features: "Online booking for patients\nReminder text to the patient the day before\nReceptionist schedule view - so that rescheduling takes one click\nDentist daily appointment list",
  out_of_scope: "Payments\nInsurance claims",
  constraints: "Booking confirmation appears within 2 seconds\nHosted in the EU",
  open_questions: "None",
});

describe("DC-02 story generation from a multi-persona DIR", () => {
  const stories = storiesFromDir(clinic);
  it("one story per must-have feature, each with one named persona (not the whole Users field)", () => {
    expect(stories.map(s => s.as_a)).toEqual(["Patient", "Patient", "Receptionist", "Dentist"]);
    for (const s of stories) expect(s.as_a).not.toContain("\n");
  });
  it("one specific benefit per story, drawn from the DIR, never the whole problem field", () => {
    expect(stories[2].so_that).toBe("rescheduling takes one click");
    expect(stories[2].i_want).toBe("Receptionist schedule view");
    expect(stories[1].so_that).toMatch(/nobody sends reminders/);
    for (const s of stories) expect(s.so_that).not.toContain("Patients cannot book appointments outside office hours. Receptionists");
  });
  it("concrete Given/When/Then with observable outcomes, a refusal case, scope and measurable constraints", () => {
    const g = stories[0].gherkin;
    expect(g).toMatch(/Given Patient is signed in/);
    expect(g).toMatch(/Then the app shows a confirmation that "Online booking for patients" succeeded/);
    expect(g).toMatch(/still shown to Patient after the page is reloaded/);
    expect(g).toMatch(/Then the app says which detail is missing and nothing is saved/);
    expect(g).toMatch(/does not offer "Payments"/);
    expect(g).toMatch(/within 2 seconds/); // booking constraint on the booking story
    expect(stories[1].gherkin).not.toMatch(/within 2 seconds/); // ...and not on the unrelated reminder story
    for (const s of stories) expect(s.gherkin).not.toMatch(/behaviour described for it in the approved DIR/);
  });
  it("each story traces to DIR lines and carries a GP1P action ID", () => {
    expect(stories[2].dir_refs).toEqual({ feature: "must_have_features[3]", persona: "users_personas[2]", benefit: "must_have_features[3]" });
    expect(stories[1].dir_refs?.benefit).toBe("problem_statement[3]");
    expect(stories.map(s => s.gp1p_action_id)).toEqual(["GP1P.STORY.ST01", "GP1P.STORY.ST02", "GP1P.STORY.ST03", "GP1P.STORY.ST04"]);
  });
  it("is deterministic and still refuses a DIR with no features", () => {
    expect(storiesFromDir(clinic)).toEqual(stories);
    expect(() => storiesFromDir(dir({ users_personas: "Patient" }))).toThrow("DIR_HAS_NO_FEATURES");
  });
  it("a one-line persona list is split into separate personas", () => {
    const s = storiesFromDir(dir({ users_personas: "Clinic receptionists, patients and dentists", must_have_features: "Patients see open slots\nDentists see their day", problem_statement: "Booking is slow." }));
    expect(s.map(x => x.as_a)).toEqual(["patients", "dentists"]);
  });
});
