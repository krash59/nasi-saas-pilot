"use client";

import { SCAFFOLD_LABELS } from "@/lib/design/scaffolding";
import type { ChatCapture } from "@/lib/design/capture";
import { formatTranscript, transcriptFileName } from "@/lib/design/transcript";
import type { SummaryFields } from "@/lib/design/summary-fields";
import { useEffect, useState } from "react";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";

export function DesignChat({ projectId }: { projectId: string }) {
  const [messages, setMessages] = useState<
    { id?: string; role: string; content: string; is_ai_draft: boolean; created_at?: string; edited_at?: string | null; withdrawn_at?: string | null }[]
  >([]);
  const [projectName, setProjectName] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [fields, setFields] = useState<SummaryFields | null>(null);
  const [capture, setCapture] = useState<ChatCapture | null>(null);
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
    if (d.capture) setCapture(d.capture);
    if (typeof d.projectName === "string") setProjectName(d.projectName);
    if (typeof d.chatOpen === "boolean") setChatOpen(d.chatOpen);
  }

  // DC-01: edit or withdraw your own message before the Design Summary is approved (earlier text is kept in history).
  async function revise(body: { action: "edit"; messageId: string; content: string } | { action: "withdraw"; messageId: string }) {
    setError(null);
    const res = await apiFetch(`/api/projects/${projectId}/design/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error === "DESIGN_DISCUSSION_CLOSED" ? "The design is approved, so messages can no longer change." : "That change could not be saved.");
      return;
    }
    setMessages(data.messages ?? []);
    setEditing(null);
  }

  // DC-04: download a readable copy to share with team members.
  function download() {
    const at = new Date();
    const blob = new Blob([formatTranscript(projectName || "Project", messages, at)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = transcriptFileName(projectName || "project", at);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    loadConversation().catch(() => setError("Could not load messages"));
  }, [projectId]);

  const FOCUS_LABELS: Record<string, string> = { ...SCAFFOLD_LABELS, original_description: "your app idea", decisions: "decisions, changes and notes" };
  const focus = capture ? capture.next_focus : null;

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
    if (data.capture) setCapture(data.capture);
    setInput("");
  }

  return (
    <div>
      <p>
        <a href={`/dashboard/projects/${projectId}/summary`}>Review Design Summary</a>
      </p>
      <p role="note" style={{ fontSize: 14 }}>
        Your conversation is saved. You can leave and come back later to carry on where you left off.{" "}
        <button type="button" onClick={download} disabled={!messages.length}>Download conversation</button>{" "}
        Share the file with your team; add their input by typing it into the chat.
      </p>
      {assistantMode === "local_stub" && (
        <p role="status">Local offline assistant is active. Replies are deterministic test drafts.</p>
      )}
      {focus && (
        <p style={{ fontSize: 14, color: "#444" }}>
          Guided focus: <strong>{FOCUS_LABELS[focus]}</strong> — saved as you chat; confirm on
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
            {m.withdrawn_at ? (
              <div style={{ fontStyle: "italic", color: "#666" }}>You withdrew this message.</div>
            ) : editing && editing.id === m.id ? (
              <div>
                <textarea aria-label="Edit your message" value={editing.text} rows={3} style={{ width: "100%" }}
                  onChange={(e) => setEditing({ id: editing.id, text: e.target.value })} />
                <button type="button" disabled={!editing.text.trim()}
                  onClick={() => revise({ action: "edit", messageId: editing.id, content: editing.text.trim() })}>Save change</button>{" "}
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <div>
                {m.content}
                {m.edited_at && <span style={{ fontSize: 12, marginLeft: 8, color: "#666" }}>(edited)</span>}
              </div>
            )}
            {m.role === "customer" && m.id && !m.withdrawn_at && chatOpen && !(editing && editing.id === m.id) && (
              <div style={{ fontSize: 12 }}>
                <button type="button" onClick={() => setEditing({ id: m.id!, text: m.content })}>Edit</button>{" "}
                <button type="button" onClick={() => revise({ action: "withdraw", messageId: m.id! })}>Withdraw</button>
              </div>
            )}
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
