import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";
import { recordSecurityEvent } from "@/lib/security/audit";

/**
 * BDD_F11_01: the customer exports all of their own data while active and during the
 * 30-day offboarding window (DATA_RETENTION_POLICY_DRAFT RET_D05). Every read runs under
 * tenant RLS, so the bundle can only ever contain the requester's rows.
 */
export async function exportCustomerData() {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const open = await tx`SELECT customer_export_window_open() AS open`;
    if (!open[0]?.open) throw new Error("EXPORT_WINDOW_CLOSED");
    const account = await tx`SELECT id, created_at, offboard_requested_at FROM customers`;
    const bundle = {
      format: "nasi-customer-export-v1",
      exported_at: new Date().toISOString(),
      account: account[0] ?? null,
      projects: await tx`SELECT id, name, status, lifecycle_stage, archived_at, created_at FROM projects ORDER BY created_at`,
      design_messages: await tx`SELECT id, project_id, role, content, is_ai_draft, created_at FROM design_messages ORDER BY created_at`,
      design_summaries: await tx`SELECT project_id, fields, status, approved_at FROM design_summaries`,
      dir_drafts: await tx`SELECT project_id, status, content, approved_at FROM dir_drafts`,
      implementation_consents: await tx`SELECT id, project_id, dir_sha256, granted_at, expires_at, revoked_at FROM implementation_consents ORDER BY granted_at`,
      usage: await tx`SELECT project_id, meter, quantity, source, occurred_at FROM usage_meter_events ORDER BY occurred_at`,
      security_events: await tx`SELECT event_type, resource_type, resource_id, created_at FROM security_audit_events ORDER BY created_at`,
      billing_account: (await tx`SELECT status, stripe_customer_id, stripe_subscription_id FROM pilot_billing_accounts`)[0] ?? null,
      billing_events: await tx`SELECT event_id, event_created, received_at FROM pilot_billing_events ORDER BY event_created`,
    };
    await recordSecurityEvent(tx, customer.id, "DATA_EXPORTED", "account", customer.id);
    return bundle;
  });
}

/** Start offboarding: opens the 30-day export window, after which the purge job erases the account. */
export async function requestOffboarding() {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`SELECT request_offboarding() AS at`;
    const at = new Date(rows[0].at as string);
    await recordSecurityEvent(tx, customer.id, "OFFBOARDING_REQUESTED", "account", customer.id);
    return { offboard_requested_at: at.toISOString(), export_until: new Date(at.getTime() + 30 * 86400_000).toISOString() };
  });
}

/** Archive a project: starts its 90-day retention clock (RET_D01/RET_D02). */
export async function archiveProject(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`UPDATE projects SET status = 'archived', archived_at = COALESCE(archived_at, now())
      WHERE id = ${projectId}::uuid RETURNING id, status, archived_at`;
    if (!rows.length) throw new Error("NOT_FOUND");
    await recordSecurityEvent(tx, customer.id, "PROJECT_ARCHIVED", "project", projectId);
    return rows[0];
  });
}
