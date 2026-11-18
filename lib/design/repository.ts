import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";
import {
  allRequiredFieldsConfirmed,
  emptySummaryFields,
  type SummaryFieldKey,
  type SummaryFields,
} from "@/lib/design/summary-fields";
import { canAccessProject } from "@/lib/tenant/access";
import type { FieldProposals } from "@/lib/design/summary-extract";
import { WELCOME_MESSAGE } from "@/lib/design/scaffolding";
import { applyAiProposals } from "@/lib/design/merge-proposals";
import { recordSecurityEvent } from "@/lib/security/audit";

async function projectOwnedByCustomer(projectId: string, customerId: string) {
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customerId, async (tx) => {
    const rows = await tx`
      SELECT id, customer_id, lifecycle_stage, name, design_version FROM projects WHERE id = ${projectId}::uuid
    `;
    const row = rows[0] as { id: string; customer_id: string; lifecycle_stage: string; name: string; design_version: number } | undefined;
    if (!row || !canAccessProject({ customerId, projectCustomerId: row.customer_id })) {
      // RLS hides other tenants' rows, so "missing" and "foreign" look the same here.
      // Either way the requester was denied: record it (BDD_F05_01).
      await recordSecurityEvent(tx, customerId, "PROJECT_ACCESS_DENIED", "project", projectId);
      return null;
    }
    return row;
  });
}

export async function getProjectForCustomer(projectId: string) {
  const customer = await requireCustomer();
  return projectOwnedByCustomer(projectId, customer.id);
}

export async function listDesignMessages(projectId: string) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    return tx`
      SELECT id, role, content, is_ai_draft, created_at, edited_at, withdrawn_at
      FROM design_messages
      WHERE project_id = ${projectId}::uuid
      ORDER BY created_at ASC
    `;
  });
}

export { historyForAssistant } from "@/lib/design/history";

/**
 * DC-01: before Design Summary approval the customer may edit or withdraw THEIR OWN message. The earlier text is kept in
 * the append-only design_message_revisions table (never lost); the message row then shows only the current version.
 */
export async function reviseDesignMessage(
  projectId: string,
  messageId: string,
  change: { action: "edit"; content: string } | { action: "withdraw" },
) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    const summary = await tx`SELECT status FROM design_summaries WHERE project_id = ${projectId}::uuid`;
    if ((summary[0] as { status?: string } | undefined)?.status === "approved") throw new Error("DESIGN_DISCUSSION_CLOSED");
    const rows = await tx`
      SELECT id, role, content, withdrawn_at FROM design_messages
      WHERE id = ${messageId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE
    `;
    const msg = rows[0] as { id: string; role: string; content: string; withdrawn_at: unknown } | undefined;
    if (!msg) throw new Error("MESSAGE_NOT_FOUND");
    if (msg.role !== "customer") throw new Error("ONLY_OWN_MESSAGES");
    if (msg.withdrawn_at) throw new Error("MESSAGE_WITHDRAWN");
    if (change.action === "edit" && change.content === msg.content) return listDesignMessagesTx(tx, projectId);
    await tx`
      INSERT INTO design_message_revisions (project_id, customer_id, message_id, action, previous_content, new_content, revised_by)
      VALUES (${projectId}::uuid, ${customer.id}::uuid, ${messageId}::uuid, ${change.action}, ${msg.content},
              ${change.action === "edit" ? change.content : null}, ${customer.clerk_user_id})
    `;
    if (change.action === "edit") {
      await tx`UPDATE design_messages SET content = ${change.content}, edited_at = now() WHERE id = ${messageId}::uuid`;
    } else {
      await tx`UPDATE design_messages SET withdrawn_at = now() WHERE id = ${messageId}::uuid`;
    }
    return listDesignMessagesTx(tx, projectId);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listDesignMessagesTx(tx: any, projectId: string) {
  return tx`
    SELECT id, role, content, is_ai_draft, created_at, edited_at, withdrawn_at
    FROM design_messages WHERE project_id = ${projectId}::uuid ORDER BY created_at ASC
  `;
}

export async function appendDesignMessage(
  projectId: string,
  role: "customer" | "assistant",
  content: string,
  isAiDraft: boolean,
) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    return tx`
      INSERT INTO design_messages (project_id, role, content, is_ai_draft)
      VALUES (${projectId}::uuid, ${role}, ${content}, ${isAiDraft})
      RETURNING id, role, content, is_ai_draft, created_at
    `;
  });
}

export async function getOrCreateSummary(projectId: string) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    const existing = await tx`
      SELECT project_id, fields, status, approved_at FROM design_summaries
      WHERE project_id = ${projectId}::uuid
    `;
    if (existing.length > 0) return existing[0];
    // Concurrent first loads must not collide (unique project_id): create once, then read.
    await tx`
      INSERT INTO design_summaries (project_id, fields)
      VALUES (${projectId}::uuid, ${JSON.stringify(emptySummaryFields())}::jsonb)
      ON CONFLICT (project_id) DO NOTHING
    `;
    const created = await tx`
      SELECT project_id, fields, status, approved_at FROM design_summaries
      WHERE project_id = ${projectId}::uuid
    `;
    return created[0];
  });
}

export async function confirmSummaryField(
  projectId: string,
  field: SummaryFieldKey,
  customerConfirmed: string | null,
  aiProposed?: string | null,
) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    // A customer can confirm a field before the page's first summary load finishes (found by the G3-10 browser
    // check): create the empty summary for this owned project (RLS-bound) instead of failing with SUMMARY_NOT_FOUND.
    await tx`
      INSERT INTO design_summaries (project_id, fields)
      VALUES (${projectId}::uuid, ${JSON.stringify(emptySummaryFields())}::jsonb)
      ON CONFLICT (project_id) DO NOTHING
    `;
    const row = await tx`
      SELECT fields, status FROM design_summaries WHERE project_id = ${projectId}::uuid
    `;
    if (row.length === 0) throw new Error("SUMMARY_NOT_FOUND");
    if ((row[0] as { status: string }).status === "approved") {
      throw new Error("SUMMARY_ALREADY_APPROVED");
    }
    const fields = (row[0] as { fields: SummaryFields }).fields ?? emptySummaryFields();
    fields[field] = {
      ai_proposed: aiProposed ?? fields[field]?.ai_proposed ?? null,
      customer_confirmed: customerConfirmed,
    };
    const ready = allRequiredFieldsConfirmed(fields);
    await tx`
      UPDATE design_summaries
      SET fields = ${JSON.stringify(fields)}::jsonb,
          status = ${ready ? "ready_for_review" : "draft"},
          updated_at = now()
      WHERE project_id = ${projectId}::uuid
    `;
    return fields;
  });
}

export async function approveDesignSummary(projectId: string) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    const row = await tx`
      SELECT fields, status FROM design_summaries WHERE project_id = ${projectId}::uuid
    `;
    if (row.length === 0) throw new Error("SUMMARY_NOT_FOUND");
    const fields = (row[0] as { fields: SummaryFields }).fields;
    if (row[0].status === "approved") return { status: "approved" as const };
    if (!allRequiredFieldsConfirmed(fields)) throw new Error("FIELDS_NOT_CONFIRMED");
    await tx`
      UPDATE design_summaries
      SET status = 'approved', approved_at = now(), updated_at = now()
      WHERE project_id = ${projectId}::uuid
    `;
    await tx`
      UPDATE projects SET lifecycle_stage = 'design_summary_review'
      WHERE id = ${projectId}::uuid
    `;
    return { status: "approved" as const };
  });
}

export async function getSummaryFields(projectId: string): Promise<SummaryFields> {
  const row = await getOrCreateSummary(projectId);
  return ((row as { fields: SummaryFields }).fields ?? emptySummaryFields()) as SummaryFields;
}

export async function mergeAiProposedFields(projectId: string, proposals: FieldProposals) {
  const keys = Object.keys(proposals) as SummaryFieldKey[];
  if (keys.length === 0) return getSummaryFields(projectId);

  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    const row = await tx`
      SELECT fields, status FROM design_summaries WHERE project_id = ${projectId}::uuid
    `;
    if (row.length === 0) throw new Error("SUMMARY_NOT_FOUND");
    if ((row[0] as { status: string }).status === "approved") {
      return (row[0] as { fields: SummaryFields }).fields;
    }
    const fields = (row[0] as { fields: SummaryFields }).fields ?? emptySummaryFields();
    const merged = applyAiProposals(fields, proposals);
    await tx`
      UPDATE design_summaries
      SET fields = ${JSON.stringify(merged)}::jsonb, updated_at = now()
      WHERE project_id = ${projectId}::uuid
    `;
    return merged;
  });
}

/** Persistent conversation bootstrap (DIR §5.2 exit: persistent conversation). */
export async function ensureDesignConversationStarted(projectId: string) {
  const existing = await listDesignMessages(projectId);
  if (existing.length > 0) return existing;
  await appendDesignMessage(projectId, "assistant", WELCOME_MESSAGE, false);
  await getOrCreateSummary(projectId);
  return listDesignMessages(projectId);
}

export async function assertDesignChatOpen(projectId: string) {
  const info = await getProjectStageInfo(projectId);
  if (info?.summary_status === "approved") {
    throw new Error("DESIGN_DISCUSSION_CLOSED");
  }
}

export async function getProjectStageInfo(projectId: string) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    const rows = await tx`
      SELECT p.lifecycle_stage, s.status AS summary_status
      FROM projects p
      LEFT JOIN design_summaries s ON s.project_id = p.id
      WHERE p.id = ${projectId}::uuid
    `;
    return rows[0] as { lifecycle_stage: string; summary_status: string | null } | undefined;
  });
}
