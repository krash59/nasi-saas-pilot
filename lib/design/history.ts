/** DC-01: what the AI is given: current text only; withdrawn messages are left out entirely. */
export function historyForAssistant(rows: { role: string; content: string; withdrawn_at?: unknown }[]) {
  return rows
    .filter((m) => !m.withdrawn_at)
    .map((m) => ({ role: m.role as "customer" | "assistant", content: m.content }));
}
