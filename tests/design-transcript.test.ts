import { describe, expect, it } from "vitest";
import { formatTranscript, transcriptFileName } from "@/lib/design/transcript";

// DC-04: the design conversation page's Download button produces this readable file.
describe("DC-04 design conversation download", () => {
  const at = new Date("2026-11-18T15:04:00Z");
  const file = formatTranscript("Clinic booking", [
    { role: "assistant", content: "Hi! What are you building?", is_ai_draft: false, created_at: "2026-11-18T14:00:00Z" },
    { role: "customer", content: "We run two dental clinics", created_at: "2026-11-18T14:01:00Z", edited_at: "2026-11-18T14:05:00Z" },
    { role: "customer", content: "secret typo", created_at: "2026-11-18T14:02:00Z", withdrawn_at: "2026-11-18T14:03:00Z" },
    { role: "assistant", content: "Who books the visits?", is_ai_draft: true, created_at: "2026-11-18T14:02:30Z" },
  ], at);
  it("shows the project name and the date/time", () => {
    expect(file).toContain("# Design conversation: Clinic booking");
    expect(file).toContain("Downloaded: 2026-11-18 15:04 UTC");
  });
  it("states the conversation is saved and resumable, and how team input comes back", () => {
    expect(file).toMatch(/saved in NASI\. You can come back later and carry on/);
    expect(file).toMatch(/type it into the design chat yourself/);
  });
  it("shows each turn, marks AI drafts and edits, and never prints withdrawn text", () => {
    expect(file).toContain("## You (2026-11-18 14:01 UTC)\nWe run two dental clinics");
    expect(file).toContain("_(Edited 2026-11-18 14:05 UTC)_");
    expect(file).toContain("## AI (draft) (2026-11-18 14:02 UTC)\nWho books the visits?");
    expect(file).toContain("_[You withdrew this message.]_");
    expect(file).not.toContain("secret typo");
  });
  it("gives a safe, dated file name", () => {
    expect(transcriptFileName("Clinic booking / v2!", at)).toBe("design-conversation-clinic-booking-v2-202611181504.md");
  });
});
