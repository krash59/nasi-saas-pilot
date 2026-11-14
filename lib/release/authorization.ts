import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

export type ReleaseDecision = "approved" | "rejected";

/**
 * BDD_F09_01 ACT_05A: the signed-in customer approves or rejects one exact release of their app.
 * Requires the project's DIR to be customer-approved. Append-only: a later decision supersedes.
 */
export async function recordCustomerReleaseDecision(projectId: string, releaseRef: string, decision: ReleaseDecision) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const dir = await tx`SELECT 1 FROM dir_drafts WHERE project_id = ${projectId}::uuid AND status = 'approved' AND approved_at IS NOT NULL`;
    if (!dir.length) throw new Error("DIR_NOT_APPROVED");
    const rows = await tx`INSERT INTO customer_release_authorizations (project_id, customer_id, release_ref, decision, decided_by)
      VALUES (${projectId}::uuid, ${customer.id}::uuid, ${releaseRef}, ${decision}, ${customer.clerk_user_id})
      RETURNING id, release_ref, decision, decided_at, expires_at`;
    return { authorization: rows[0], productionReleaseAuthorized: false };
  });
}

/** Both parties' latest decisions and the deploy log for a release, as the customer sees them. */
export async function getReleaseStatus(projectId: string, releaseRef: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const latest = (rows: Record<string, unknown>[]) => rows[0] ?? null;
    return {
      release_ref: releaseRef,
      customer: latest(await tx`SELECT decision, decided_at, expires_at FROM customer_release_authorizations
        WHERE project_id = ${projectId}::uuid AND release_ref = ${releaseRef} ORDER BY decided_at DESC, id DESC LIMIT 1`),
      platform: latest(await tx`SELECT decision, decided_by, reason, decided_at, expires_at FROM platform_production_authorizations
        WHERE project_id = ${projectId}::uuid AND release_ref = ${releaseRef} ORDER BY decided_at DESC, id DESC LIMIT 1`),
      deploy_log: await tx`SELECT outcome, reason, at FROM production_deploy_decisions
        WHERE project_id = ${projectId}::uuid AND release_ref = ${releaseRef} ORDER BY at`,
    };
  });
}
