import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/** BDD_F06_01 / DIR §8.4: the customer sees break-glass access to their projects (unless a documented exception applies). */
export async function listBreakGlassForCustomer() {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const grants = await tx`SELECT id, project_id, engineer, approver, reason, minutes, requested_at, approved_at, expires_at, closed_at
      FROM break_glass_grants ORDER BY requested_at DESC`;
    const log = await tx`SELECT grant_id, actor, action, detail, at FROM break_glass_access_log ORDER BY at`;
    return grants.map(g => ({ ...g, log: log.filter(l => l.grant_id === g.id).map(({ grant_id: _g, ...l }) => l) }));
  });
}
