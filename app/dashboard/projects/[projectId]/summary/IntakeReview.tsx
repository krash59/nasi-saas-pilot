"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";
import type { IntakeView } from "@/lib/intake/project";
import ReviseDesign from "../ReviseDesign";

/**
 * Check-your-answers page (design v3 R8-R11, GOV.UK "Check answers" pattern). Shows ONLY the customer's own words, per
 * question, with Change and Confirm; open questions must be marked Open or Settled (with the customer's decision) before
 * approval. Nothing here is written by AI.
 */
const ISSUE_TEXT: Record<string, string> = {
  FIELD_EMPTY: "has no answer yet (answer it, or press None in the chat)",
  UNCONFIRMED_SECTION: "is not confirmed yet",
  NEEDS_RECHECK: "changed after you confirmed it; please check and confirm again",
  QUESTION_STATUS_MISSING: "needs a status: Still open, or Settled with your decision",
};

export function IntakeReview({ projectId, status, onChanged }: { projectId: string; status: string; onChanged: () => void }) {
  const apiFetch = useAuthenticatedApiFetch();
  const [view, setView] = useState<IntakeView | null>(null);
  const [changing, setChanging] = useState<{ id: string; text: string } | null>(null);
  const [decision, setDecision] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const approved = status === "approved";

  async function load() {
    const res = await apiFetch(`/api/projects/${projectId}/intake`);
    const data = await res.json();
    if (res.ok) setView(data.view);
  }
  useEffect(() => { load(); }, [projectId]);

  async function act(body: Record<string, string>) {
    setMsg(null);
    const res = await apiFetch(`/api/projects/${projectId}/intake`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error); return false; }
    setView(data.view);
    return true;
  }

  async function approve() {
    const res = await apiFetch(`/api/projects/${projectId}/design/summary`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error === "INTAKE_GATE_FAILED" ? "Not ready yet: see the list above." : data.error); return; }
    setMsg(data.dir_error ? "Summary approved. DIR generation failed; use the recovery button to retry."
      : "Design Summary approved and DIR draft saved for review. This does not start implementation.");
    onChanged();
  }

  if (!view) return <p>Loading your answers…</p>;
  const labelOf = (ref: string) => view.questions.find((q) => q.id === ref)?.heading
    ?? `Open question "${view.open_items.find((i) => i.item_id === ref)?.text ?? ref}"`;

  return (
    <div>
      <p style={{ fontSize: 14 }}>
        These are your own words from the design chat, word for word. Only what you confirm here goes into your requirements.
        Nothing on this page was written by AI.
      </p>
      {view.questions.map((q) => (
        <section key={q.id} style={{ borderTop: "1px solid #ccc", padding: "0.5rem 0" }}>
          <h3 style={{ margin: "0.25rem 0" }}>{q.heading}</h3>
          <div style={{ fontSize: 13, color: "#555" }}>{q.text}</div>
          {changing?.id === q.id ? (
            <div>
              <textarea aria-label={`Change your answer: ${q.heading}`} rows={6} style={{ width: "100%" }} value={changing.text}
                onChange={(e) => setChanging({ id: q.id, text: e.target.value })} />
              <button type="button" disabled={!changing.text.trim()}
                onClick={async () => { if (await act({ action: "change", question_id: q.id, text: changing.text.trim() })) setChanging(null); }}>Save my answer</button>{" "}
              <button type="button" onClick={() => setChanging(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ whiteSpace: "pre-wrap" }}>
              {q.state === "none" ? <em>None (you said this does not apply)</em>
                : q.state === "empty" ? <em>No answer yet</em>
                : q.answers.map((a) => a.text).join("\n\n")}
            </div>
          )}
          {!approved && changing?.id !== q.id && (
            <div style={{ fontSize: 13 }}>
              <button type="button" onClick={() => setChanging({ id: q.id, text: q.answers.map((a) => a.text).join("\n\n") })}>Change</button>{" "}
              <button type="button" disabled={q.state === "empty" || q.confirmation === "confirmed"} onClick={() => act({ action: "confirm", question_id: q.id })}>
                {q.confirmation === "confirmed" ? "Confirmed" : "Confirm this section"}
              </button>
              {q.confirmation === "needs_recheck" && <strong style={{ marginLeft: 8 }}>Changed since you confirmed it</strong>}
            </div>
          )}
        </section>
      ))}

      {view.open_items.length > 0 && (
        <section style={{ borderTop: "2px solid #888", paddingTop: "0.5rem" }}>
          <h3>Your open questions</h3>
          <p style={{ fontSize: 13 }}>For each one, say whether it is still open or settled. If settled, type your decision in your own words.</p>
          {view.open_items.map((it) => (
            <div key={it.item_id} style={{ marginBottom: "0.75rem" }}>
              <div>{it.text}</div>
              <div style={{ fontSize: 13 }}>Status: <strong>{it.status === "UNSET" ? "not set" : it.status === "NEEDS_RECHECK" ? "changed, set again" : it.status.toLowerCase()}</strong>
                {it.decision && <> — your decision: {it.decision}</>}{it.note && <> — open because: {it.note}</>}</div>
              {!approved && (
                <div style={{ fontSize: 13 }}>
                  <input aria-label={`Why it is still open: ${it.text}`} placeholder="Why it is still open (optional)" value={note[it.item_id] ?? ""}
                    onChange={(e) => setNote({ ...note, [it.item_id]: e.target.value })} />{" "}
                  <button type="button" onClick={() => act({ action: "mark_open", item_id: it.item_id, ...(note[it.item_id]?.trim() ? { note: note[it.item_id].trim() } : {}) })}>Still open</button>{" "}
                  <input aria-label={`Your decision: ${it.text}`} placeholder="Your decision, in your words" value={decision[it.item_id] ?? ""}
                    onChange={(e) => setDecision({ ...decision, [it.item_id]: e.target.value })} />{" "}
                  <button type="button" disabled={!decision[it.item_id]?.trim()} onClick={() => act({ action: "settle", item_id: it.item_id, decision: decision[it.item_id].trim() })}>Settled</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {!approved && (
        <section style={{ borderTop: "2px solid #888", paddingTop: "0.5rem" }}>
          {view.gate.pass ? <p>Everything is answered, confirmed and settled or marked open.</p> : (
            <>
              <p>Before you can approve:</p>
              <ul>{view.gate.issues.map((i) => <li key={i.code + i.ref}>{labelOf(i.ref)} {ISSUE_TEXT[i.code]}</li>)}</ul>
            </>
          )}
          <button type="button" disabled={!view.gate.pass} onClick={approve}>Approve Design Summary</button>
        </section>
      )}
      {msg && <p role="status">{msg}</p>}
      {approved && <>
        <ReviseDesign projectId={projectId} />
        <p><Link href={`/dashboard/projects/${projectId}/dir`}>Review DIR draft</Link></p>
      </>}
    </div>
  );
}
