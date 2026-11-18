/** DC-04: a readable copy of the design conversation for sharing with team members (download on the chat page only). */
export type TranscriptMessage = {
  role: string;
  content: string;
  is_ai_draft?: boolean;
  created_at?: string | Date | null;
  edited_at?: string | Date | null;
  withdrawn_at?: string | Date | null;
};

const stamp = (v: string | Date | null | undefined) => {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
};

export function transcriptFileName(projectName: string, at: Date): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  return `design-conversation-${slug}-${at.toISOString().slice(0, 16).replace(/[-:T]/g, "")}.md`;
}

export function formatTranscript(projectName: string, messages: TranscriptMessage[], at: Date): string {
  const lines = [
    `# Design conversation: ${projectName}`,
    "",
    `Downloaded: ${stamp(at)}`,
    "",
    "This conversation is saved in NASI. You can come back later and carry on where you left off.",
    "To add your team's input, type it into the design chat yourself; this file is a copy for reading only.",
    "AI replies are drafts until you confirm the fields on the Design Summary page.",
    "",
  ];
  for (const m of messages) {
    const who = m.role === "assistant" ? (m.is_ai_draft ? "AI (draft)" : "NASI assistant") : "You";
    const when = stamp(m.created_at);
    lines.push(`## ${who}${when ? ` (${when})` : ""}`);
    if (m.withdrawn_at) {
      lines.push("_[You withdrew this message.]_");
    } else {
      lines.push(m.content);
      if (m.edited_at) lines.push("", `_(Edited ${stamp(m.edited_at)})_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
