import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/** Called only after explicit reviewed-content confirmation by the signed-in customer. */
export async function authorizeImplementation(projectId: string, reviewedContent: unknown) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    // BDD_F07_02 / DIR §5.2: an unrevoked, unexpired consent is one card in progress.
    // Lock per project so two concurrent requests cannot both take the last slot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`impl-wip:${projectId}`}))`;
    const wip = await tx`SELECT p.implementation_wip_limit AS wip_limit,
        (SELECT count(*)::int FROM implementation_consents c
          WHERE c.project_id = p.id AND c.revoked_at IS NULL AND c.expires_at > now()) AS in_progress
      FROM projects p WHERE p.id = ${projectId}::uuid AND p.customer_id = ${customer.id}::uuid`;
    if (wip.length && Number(wip[0].in_progress) >= Number(wip[0].wip_limit)) {
      throw new Error("IMPLEMENTATION_WIP_LIMIT_REACHED");
    }
    const rows = await tx`WITH eligible AS (
      SELECT d.project_id, d.customer_id, encode(digest(d.content::text, 'sha256'), 'hex') AS dir_sha256
      FROM dir_drafts d JOIN projects p ON p.id = d.project_id
      WHERE p.id = ${projectId}::uuid AND p.customer_id = ${customer.id}::uuid
        AND d.customer_id = ${customer.id}::uuid AND d.status = 'approved'
        AND d.approved_at IS NOT NULL AND d.approved_by = ${customer.clerk_user_id}
        AND d.content = ${JSON.stringify(reviewedContent)}::jsonb
      FOR UPDATE OF d
    ) INSERT INTO implementation_consents(project_id, customer_id, dir_sha256, approved_by)
      SELECT project_id, customer_id, dir_sha256, ${customer.clerk_user_id} FROM eligible
      RETURNING id, project_id, dir_sha256, expires_at, implementation_scope`;
    if (!rows.length) throw new Error("APPROVED_DIR_REVIEW_MISMATCH");
    return { consent: rows[0], nwsExecutionAuthorized: false, productionReleaseAuthorized: false };
  });
}

/** Read-back revalidates owner, current approved DIR digest, expiry and revocation. */
export async function getImplementationConsent(projectId: string, consentId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`SELECT c.id, c.project_id, c.dir_sha256, c.expires_at, c.implementation_scope
      FROM implementation_consents c JOIN dir_drafts d ON d.project_id = c.project_id
      JOIN projects p ON p.id = c.project_id
      WHERE c.id = ${consentId}::uuid AND c.project_id = ${projectId}::uuid
        AND c.customer_id = ${customer.id}::uuid AND p.customer_id = ${customer.id}::uuid
        AND d.customer_id = ${customer.id}::uuid AND d.status = 'approved'
        AND d.approved_by = ${customer.clerk_user_id} AND c.approved_by = ${customer.clerk_user_id}
        AND d.approved_at IS NOT NULL
        AND c.dir_sha256 = encode(digest(d.content::text, 'sha256'), 'hex')
        AND c.revoked_at IS NULL AND c.expires_at > now()`;
    return rows[0] ?? null;
  });
}

/** Customer ends an in-progress card, freeing its WIP slot. Only the owner's own active consent. */
export async function revokeImplementation(projectId: string, consentId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`UPDATE implementation_consents SET revoked_at = now()
      WHERE id = ${consentId}::uuid AND project_id = ${projectId}::uuid
        AND customer_id = ${customer.id}::uuid AND revoked_at IS NULL
      RETURNING id, revoked_at`;
    if (!rows.length) throw new Error("CONSENT_NOT_FOUND");
    return rows[0];
  });
}
