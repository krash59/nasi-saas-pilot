import type { ChatCapture } from "@/lib/design/capture";
import { allRequiredFieldsConfirmed, SUMMARY_FIELD_KEYS, type SummaryFields } from "./summary-fields";

export const DIR_LABELS = ["Problem statement", "Users / personas", "Must-have features", "Out of scope", "Constraints", "Open questions"];

/** Deterministic draft: no model call and no inferred requirements. */
/** Customer's own words from the chat (deterministic capture), formatted by a fixed template. */
export function chatSections(capture?: Pick<ChatCapture, "original_description" | "decisions"> | null) {
  if (!capture) return [];
  const out: { key: string; title: string; content: string }[] = [];
  if (capture.original_description?.trim()) {
    out.push({ key: "original_description", title: "Original description (customer's own words)", content: capture.original_description.trim() });
  }
  const decisions = (capture.decisions ?? []).filter((d) => d.text.trim());
  if (decisions.length) {
    out.push({
      key: "chat_decisions", title: "Decisions and notes from the design chat (customer's own words)",
      content: decisions.map((d, i) => `${i + 1}. Customer: ${d.text.trim()}` + (d.in_reply_to ? `\n   (in reply to the assistant: ${d.in_reply_to.trim()})` : "")).join("\n\n"),
    });
  }
  return out;
}

export function buildDirDraft(summary: { status: string; approved_at: unknown; fields: SummaryFields }, capture?: Pick<ChatCapture, "original_description" | "decisions"> | null) {
  if (summary.status !== "approved" || !summary.approved_at) throw new Error("DESIGN_SUMMARY_NOT_APPROVED");
  if (!allRequiredFieldsConfirmed(summary.fields)) throw new Error("FIELDS_NOT_CONFIRMED");
  return {
    status: "AI_DRAFT" as const,
    sections: [
      ...SUMMARY_FIELD_KEYS.map((key, i): { key: string; title: string; content: string } => ({
        key, title: DIR_LABELS[i], content: summary.fields[key].customer_confirmed!,
      })),
      ...chatSections(capture),
    ],
    governance: "Draft for customer review. Design Summary approval does not approve this DIR or authorize implementation, deployment, billing, or NWS/GAS canonical changes.",
  };
}

export type DirDraftContent = ReturnType<typeof buildDirDraft>;
