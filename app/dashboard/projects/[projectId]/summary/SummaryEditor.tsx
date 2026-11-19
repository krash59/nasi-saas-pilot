"use client";

import { SUMMARY_FIELD_KEYS } from "@/lib/design/summary-fields";
import ReviseDesign from "../ReviseDesign";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";
import type { ChatCapture } from "@/lib/design/capture";

const LABELS: Record<string, string> = {
  problem_statement: "Problem statement",
  users_personas: "Users / personas",
  must_have_features: "Must-have features",
  out_of_scope: "Out of scope",
  constraints: "Constraints",
  open_questions: "Open questions",
};

export function SummaryEditor({ projectId }: { projectId: string }) {
  const [fields, setFields] = useState<
    Record<string, { ai_proposed: string | null; customer_confirmed: string | null }>
  >({});
  const [status, setStatus] = useState("draft");
  const [msg, setMsg] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [filling, setFilling] = useState(false);
  const [capture, setCapture] = useState<ChatCapture | null>(null);
  const apiFetch = useAuthenticatedApiFetch();

  async function generateDir() {
    setGenerating(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/dir`, { method: "POST" });
      const data = await res.json();
      setMsg(res.ok ? "DIR draft generated and saved for your review." : data.error);
    } catch {
      setMsg("Could not generate the DIR draft. Please retry.");
    } finally {
      setGenerating(false);
    }
  }

  /** Copies your own chat answers, word for word, into the fields you have not filled yet (no AI). */
  async function fillFromChat() {
    setFilling(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/design/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fill_from_chat" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error);
        return;
      }
      setMsg(data.filled?.length ? "Your chat answers were copied into the empty fields. Edit any field if you want to change it." : "No new chat answers to copy.");
      await load();
    } catch {
      setMsg("Could not fill from chat. Please retry.");
    } finally {
      setFilling(false);
    }
  }

  async function load() {
    const res = await apiFetch(`/api/projects/${projectId}/design/summary`);
    const data = await res.json();
    if (data.summary?.fields) setFields(data.summary.fields);
    if (data.summary?.status) setStatus(data.summary.status);
    if (data.capture) setCapture(data.capture);
  }

  useEffect(() => {
    load();
  }, [projectId]);

  async function confirmField(field: string, value: string, aiProposed?: string | null) {
    const res = await apiFetch(`/api/projects/${projectId}/design/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "confirm_field",
        field,
        customer_confirmed: value,
        ai_proposed: aiProposed ?? undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error);
      return;
    }
    setFields(data.fields);
    setMsg(null);
    await load();
  }

  async function approve() {
    const res = await apiFetch(`/api/projects/${projectId}/design/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error);
      return;
    }
    setMsg(data.dir_error
      ? "Summary approved. DIR generation failed; use the recovery button to retry."
      : "Design Summary approved and DIR draft saved for review. This does not start implementation.");
    await load();
  }

  return (
    <div>
      <p>
        Status: <strong>{status}</strong>
      </p>
      <p style={{ fontSize: 14 }}>
        Your own answers from the design chat appear below, word for word. Only text you enter or confirm counts as
        your requirement (DIR §2.2). The assistant&apos;s replies are never copied into your requirements.
      </p>
      {status !== "approved" && (
        <p>
          <button type="button" disabled={filling} onClick={fillFromChat}>
            {filling ? "Copying your chat answers…" : "Use my chat answers"}
          </button>
        </p>
      )}
      {SUMMARY_FIELD_KEYS.map((key) => {
        const answer = capture?.answers?.[key as keyof ChatCapture["answers"]] ?? null;
        const confirmed = fields[key]?.customer_confirmed;
        return (
          <div key={key} style={{ marginBottom: "1rem" }}>
            <label htmlFor={key}>
              <strong>{LABELS[key]}</strong>
            </label>
            {answer && answer !== confirmed && (
              <div style={{ fontSize: 13, margin: "0.25rem 0" }}>
                <div>Your answer in the chat:</div>
                <p style={{ whiteSpace: "pre-wrap", margin: "0.25rem 0" }}>{answer}</p>
                {status !== "approved" && (
                  <button type="button" onClick={() => confirmField(key, answer)}>
                    Use my chat answer
                  </button>
                )}
              </div>
            )}
            <textarea
              id={key}
              defaultValue={confirmed ?? ""}
              key={`${key}-${confirmed ?? ""}`}
              rows={confirmed && confirmed.length > 200 ? 8 : 3}
              style={{ width: "100%", display: "block" }}
              disabled={status === "approved"}
              onBlur={(e) => {
                if (status === "approved") return;
                if (e.target.value.trim()) {
                  if (e.target.value.trim() !== (confirmed ?? "").trim()) confirmField(key, e.target.value.trim());
                } else if (confirmed) {
                  confirmField(key, ""); // DC-01: emptying a confirmed field clears it
                }
              }}
            />
            {confirmed && <small>Confirmed by you</small>}
          </div>
        );
      })}
      {capture?.original_description && (
        <details style={{ marginBottom: "1rem" }}>
          <summary><strong>Your original description</strong> (goes into the DIR word for word)</summary>
          <p style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{capture.original_description}</p>
        </details>
      )}
      {!!capture?.decisions?.length && (
        <details style={{ marginBottom: "1rem" }}>
          <summary><strong>Your decisions and notes from the chat</strong> ({capture.decisions.length}, go into the DIR word for word)</summary>
          <ol style={{ fontSize: 13 }}>
            {capture.decisions.map((d, i) => <li key={i} style={{ whiteSpace: "pre-wrap" }}>{d.text}</li>)}
          </ol>
        </details>
      )}
      {msg && <p role="status">{msg}</p>}
      {status === "approved" && <ReviseDesign projectId={projectId} />}
      {status === "approved" && <div>
        <p>Summary approval creates a DIR draft for review. Implementation requires separate authorization.</p>
        <button type="button" disabled={generating} onClick={generateDir}>
          {generating ? "Generating…" : "Generate / recover DIR draft"}
        </button>{" "}
        <Link href={`/dashboard/projects/${projectId}/dir`}>Review DIR draft</Link>
      </div>}
      {status !== "approved" && (
        <button type="button" onClick={approve}>
          Approve Design Summary
        </button>
      )}
    </div>
  );
}
