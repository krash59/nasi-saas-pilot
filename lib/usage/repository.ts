import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";
import { assertWithinCap, recordUsage, usageSummary, type Meter } from "@/lib/usage/meters";

/** Gate before any generative call. Throws UsageCapExceededError (fail closed). */
export async function assertDesignTokensAvailable() {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, tx =>
    assertWithinCap(tx, customer.id, "design_tokens"));
}

export async function recordProjectUsage(projectId: string, meter: Meter, quantity: number, source: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, tx =>
    recordUsage(tx, customer.id, meter, quantity, source, projectId));
}

/** Gate before any agentic/deploy step for a project. Throws UsageCapExceededError (fail closed). */
export async function assertProjectUsageAvailable(projectId: string, meter: Meter) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, tx =>
    assertWithinCap(tx, customer.id, meter, projectId));
}

export async function getUsageForProject(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, tx =>
    usageSummary(tx, customer.id, projectId));
}
