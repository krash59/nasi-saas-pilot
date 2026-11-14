import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * BDD_F08_02 / BDD_F15_01: what the customer sees about agent work on their project —
 * whether agents are halted (and why), every halt raised, verification packages and staging promotions.
 * Read-only under tenant RLS; agents and the app cannot write these (DB functions only, migration 014).
 */
export async function getAgentStatus(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const halts = await tx`SELECT id, trigger, sticky, action, detail, raised_at, cleared_by, cleared_at, clear_reason
      FROM agent_halts WHERE project_id = ${projectId}::uuid ORDER BY raised_at DESC, id`;
    return {
      halted: halts.some(h => h.sticky && !h.cleared_at),
      halts,
      verification_packages: await tx`SELECT id, release_ref, passed, checks, evidence_sha256, submitted_by, submitted_at
        FROM verification_packages WHERE project_id = ${projectId}::uuid ORDER BY submitted_at DESC, id`,
      staging_promotions: await tx`SELECT release_ref, outcome, reason, at FROM staging_promotions
        WHERE project_id = ${projectId}::uuid ORDER BY at DESC, id`,
    };
  });
}
