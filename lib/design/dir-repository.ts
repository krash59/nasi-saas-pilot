import { captureFromMessages, type CaptureRow } from "@/lib/design/capture";
import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";
import { buildDirDraft } from "./dir-draft";
import type { SummaryFields } from "./summary-fields";

export async function getDirDraft(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const rows = await tx`SELECT * FROM dir_drafts
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`;
    return rows[0] ?? null;
  });
}

export async function generateDirDraft(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const rows = await tx`SELECT s.fields, s.status, s.approved_at
      FROM design_summaries s JOIN projects p ON p.id = s.project_id
      WHERE p.id = ${projectId}::uuid AND p.customer_id = ${customer.id}::uuid`;
    if (!rows.length) throw new Error("DESIGN_SUMMARY_NOT_APPROVED");
    const summary = rows[0] as { fields: SummaryFields; status: string; approved_at: unknown };
    // The chat is closed once the summary is approved, so the capture is fixed: same messages -> same DIR.
    const messages = await tx`SELECT role, content, is_ai_draft, withdrawn_at FROM design_messages
      WHERE project_id = ${projectId}::uuid ORDER BY created_at ASC`;
    const content = buildDirDraft(summary, captureFromMessages(messages as unknown as CaptureRow[]));
    // Insertion and stage transition commit together. A retry preserves the original draft.
    const result = await tx`WITH draft AS (
      INSERT INTO dir_drafts (project_id, customer_id, content, source_summary, source_approved_at, generated_by)
      SELECT p.id, p.customer_id, ${JSON.stringify(content)}::jsonb,
        s.fields, s.approved_at, ${customer.clerk_user_id}
      FROM projects p JOIN design_summaries s ON s.project_id = p.id
      WHERE p.id = ${projectId}::uuid AND p.customer_id = ${customer.id}::uuid
        AND s.status = 'approved' AND s.approved_at IS NOT NULL
        AND s.fields = ${JSON.stringify(summary.fields)}::jsonb
      ON CONFLICT (project_id) DO UPDATE SET project_id = EXCLUDED.project_id
      RETURNING *
    ), stage AS (
      UPDATE projects SET lifecycle_stage = 'dir'
      WHERE id IN (SELECT project_id FROM draft) AND customer_id = ${customer.id}::uuid
        AND lifecycle_stage IN ('design_discussion', 'design_summary_review')
    ) SELECT * FROM draft`;
    if (!result.length) throw new Error("DESIGN_SUMMARY_NOT_APPROVED");
    return result[0];
  });
}

/** Customer-only request path: approval is bound to the content actually reviewed. */
export async function approveDirDraft(projectId: string, reviewedContent: unknown) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const rows = await tx`WITH approved AS (
      UPDATE dir_drafts d SET status = 'approved',
        approved_at = COALESCE(d.approved_at, now()),
        approved_by = COALESCE(d.approved_by, ${customer.clerk_user_id})
      FROM projects p
      WHERE d.project_id = p.id AND p.id = ${projectId}::uuid
        AND p.customer_id = ${customer.id}::uuid AND d.customer_id = ${customer.id}::uuid
        AND d.content = ${JSON.stringify(reviewedContent)}::jsonb
        AND (d.status = 'AI_DRAFT' OR (d.status = 'approved' AND d.approved_at IS NOT NULL))
      RETURNING d.*
    ), stage AS (
      UPDATE projects SET lifecycle_stage = 'agile_bdd'
      WHERE id IN (SELECT project_id FROM approved)
        AND customer_id = ${customer.id}::uuid AND lifecycle_stage = 'dir'
    ) SELECT * FROM approved`;
    if (!rows.length) throw new Error('DIR_REVIEW_MISMATCH_OR_MISSING');
    return rows[0];
  });
}
