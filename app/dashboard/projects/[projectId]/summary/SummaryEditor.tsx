"use client";

import { SUMMARY_FIELD_KEYS } from "@/lib/design/summary-fields";
import ReviseDesign from "../ReviseDesign";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";

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

  async function load() {
    const res = await apiFetch(`/api/projects/${projectId}/design/summary`);
    const data = await res.json();
    if (data.summary?.fields) setFields(data.summary.fields);
    if (data.summary?.status) setStatus(data.summary.status);
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
        AI drafts from chat appear below. Only text you enter or confirm counts as your
        requirement (DIR §2.2).
      </p>
      {SUMMARY_FIELD_KEYS.map((key) => {
        const draft = fields[key]?.ai_proposed;
        const confirmed = fields[key]?.customer_confirmed;
        return (
          <div key={key} style={{ marginBottom: "1rem" }}>
            <label htmlFor={key}>
              <strong>{LABELS[key]}</strong>
            </label>
            {draft && !confirmed && (
              <p style={{ fontSize: 13, margin: "0.25rem 0" }}>
                AI draft: {draft}
                {status !== "approved" && (
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => confirmField(key, draft, draft)}
                  >
                    Use draft as my text
                  </button>
                )}
              </p>
            )}
            <textarea
              id={key}
              defaultValue={confirmed ?? draft ?? ""}
              key={`${key}-${confirmed ?? draft ?? ""}`}
              rows={2}
              style={{ width: "100%", display: "block" }}
              disabled={status === "approved"}
              onBlur={(e) => {
                if (status === "approved") return;
                if (e.target.value.trim()) {
                  confirmField(key, e.target.value.trim(), draft);
                } else if (confirmed) {
                  confirmField(key, "", draft); // DC-01: emptying a confirmed field clears it
                }
              }}
            />
            {confirmed && <small>Confirmed by you</small>}
          </div>
        );
      })}
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
