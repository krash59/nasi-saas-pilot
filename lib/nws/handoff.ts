import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * BDD_F14_01 / DIR §6.2: map SaaS project state onto the NWS_GAS_ADAPTER_CONTRACT input fields
 * (/home/dawud/systems/docs/gp1p/nws_gas_v1/NWS_GAS_ADAPTER_CONTRACT.snl, REQUIRED_INPUT_FIELDS).
 * Rules enforced here:
 *  - E is authorized only by an active customer implementation consent bound to the approved DIR digest.
 *  - K is NEVER asserted: the SaaS holds no NWS verification evidence, so K_VERIFIED=false, K_VERIFIED_STATE=null,
 *    VERIFIED_EVIDENCE_REFERENCES=[]. SaaS verification packages are listed separately as unverified-by-NWS.
 *  - CURRENT_AUTHORIZATION_BOUNDARY comes only from the HITL consent; without it, it is null (never widened).
 *  - Nothing is sent: ADAPTER_IMPLEMENTATION_AUTHORIZED=NO in the contract, so this is a read-only preview.
 */
export const NWS_HANDOFF_FORMAT = "nasi-nws-handoff-preview-v1";

export async function buildNwsHandoff(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const dir = (await tx`SELECT encode(digest(content::text, 'sha256'), 'hex') AS sha, approved_at, approved_by
      FROM dir_drafts WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND status = 'approved' AND approved_at IS NOT NULL`)[0];
    const consent = dir ? (await tx`SELECT id, dir_sha256, implementation_scope, granted_at, expires_at FROM implementation_consents
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND revoked_at IS NULL AND expires_at > now() AND dir_sha256 = ${dir.sha as string}
      ORDER BY granted_at DESC LIMIT 1`)[0] : undefined;
    const packages = await tx`SELECT id, release_ref, passed, submitted_at FROM verification_packages
      WHERE project_id = ${projectId}::uuid ORDER BY submitted_at DESC LIMIT 20`;
    const eAuthorized = Boolean(consent);
    const missing: string[] = [];
    if (!dir) missing.push("E_TARGET_STATE: no customer-approved DIR");
    if (dir && !consent) missing.push("E_AUTHORIZED: no active implementation consent for the approved DIR");
    missing.push("K_VERIFIED_STATE: no NWS verification evidence exists for this project");
    return {
      format: NWS_HANDOFF_FORMAT,
      sent_to_nws: false,
      adapter_implementation_authorized: false,
      payload: {
        E_REFERENCE: dir ? `nasi:project:${projectId}:dir:${dir.sha}` : null,
        E_TARGET_STATE: eAuthorized ? { dir_sha256: dir!.sha, approved_at: dir!.approved_at } : null,
        E_AUTHORIZED: eAuthorized,
        E_AUTHORIZATION_PROOF_REFERENCE: eAuthorized ? `nasi:implementation_consent:${consent!.id}` : null,
        K_REFERENCE: null,
        K_VERIFIED_STATE: null,
        K_VERIFIED: false,
        K_VERIFICATION_PROOF_REFERENCE: null,
        VERIFIED_EVIDENCE_REFERENCES: [],
        CURRENT_AUTHORIZATION_BOUNDARY: eAuthorized
          ? { scope: consent!.implementation_scope, consent_id: consent!.id, expires_at: consent!.expires_at, production: false }
          : null,
      },
      not_asserted: missing,
      saas_verification_packages_unverified_by_nws: packages,
    };
  });
}
