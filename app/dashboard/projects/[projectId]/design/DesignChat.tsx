"use client";

import { SCAFFOLD_LABELS, getNextScaffoldFocus } from "@/lib/design/scaffolding";
import type { SummaryFields } from "@/lib/design/summary-fields";
import { useEffect, useState } from "react";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";

export function DesignChat({ projectId }: { projectId: string }) {
  const [messages, setMessages] = useState<
    { role: string; content: string; is_ai_draft: boolean }[]
  >([]);
  const [fields, setFields] = useState<SummaryFields | null>(null);
  const [assistantMode, setAssistantMode] = useState<"openai" | "local_stub">("openai");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const apiFetch = useAuthenticatedApiFetch();

  async function loadConversation() {
    const res = await apiFetch(`/api/projects/${projectId}/design/messages`);
    const d = await res.json();
    if (!res.ok) {
      setError(d.error ?? "Could not load messages");
      return;
    }
    setMessages(d.messages ?? []);
    if (d.assistantMode) setAssistantMode(d.assistantMode);
    if (d.fields) setFields(d.fields);
  }

  useEffect(() => {
    loadConversation().catch(() => setError("Could not load messages"));
  }, [projectId]);

  const focus = fields ? getNextScaffoldFocus(fields) : null;

  async function send() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    const res = await apiFetch(`/api/projects/${projectId}/design/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Send failed");
      return;
    }
    setMessages(data.messages ?? []);
    if (data.assistantMode) setAssistantMode(data.assistantMode);
    if (data.fields) setFields(data.fields);
    setInput("");
  }

  return (
    <div>
      <p>
        <a href={`/dashboard/projects/${projectId}/summary`}>Review Design Summary</a>
      </p>
      {assistantMode === "local_stub" && (
        <p role="status">Local offline assistant is active. Replies are deterministic test drafts.</p>
      )}
      {focus && (
        <p style={{ fontSize: 14, color: "#444" }}>
          Guided focus: <strong>{SCAFFOLD_LABELS[focus]}</strong> — saved as you chat; confirm on
          the summary page.
        </p>
      )}
      <div style={{ border: "1px solid #ccc", padding: "1rem", minHeight: 240 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: "0.75rem" }}>
            <strong>{m.role === "assistant" ? (assistantMode === "local_stub" ? "Local assistant (draft)" : "AI (draft)") : "You"}</strong>
            {m.is_ai_draft && m.role === "assistant" && (
              <span style={{ fontSize: 12, marginLeft: 8 }}>AI_DRAFT</span>
            )}
            <div>{m.content}</div>
          </div>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        style={{ width: "100%", marginTop: "0.5rem" }}
        placeholder="Describe your app idea..."
      />
      <button type="button" onClick={send} disabled={loading} style={{ marginTop: "0.5rem" }}>
        {loading ? "Thinking..." : "Send"}
      </button>
    </div>
  );
}
