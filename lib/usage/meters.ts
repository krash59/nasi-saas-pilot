import type { SqlClient } from "@/lib/db/client";

/**
 * Usage meters and private-beta caps (BDD_F10_01 / BDD_F10_02).
 * Cap values are the approved initial design defaults in DIR §10.3 / BETA_USAGE_CAPS_PROPOSED.snl.
 * Periods are calendar months in UTC.
 */
export type Meter = "design_tokens" | "agent_minutes" | "staging_deploys" | "production_deploys";

export const BETA_CAPS: Record<Meter, { limit: number; scope: "account" | "project" }> = {
  design_tokens: { limit: 750_000, scope: "account" },
  agent_minutes: { limit: 180, scope: "project" },
  staging_deploys: { limit: 15, scope: "project" },
  production_deploys: { limit: 3, scope: "project" },
};

export const METERS = Object.keys(BETA_CAPS) as Meter[];

export class UsageCapExceededError extends Error {
  constructor(public readonly meter: Meter, public readonly used: number, public readonly limit: number) {
    super("USAGE_CAP_EXCEEDED");
  }
}

function scopeFor(meter: Meter, projectId: string | null): string | null {
  if (BETA_CAPS[meter].scope === "account") return null;
  if (!projectId) throw new Error("USAGE_PROJECT_REQUIRED");
  return projectId;
}

/** Serialise check-then-record for one tenant+meter so concurrent requests cannot overshoot. */
async function lockMeter(tx: SqlClient, customerId: string, meter: Meter, projectId: string | null) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`usage:${customerId}:${meter}:${projectId ?? "-"}`}))`;
}

export async function usedThisMonth(
  tx: SqlClient,
  customerId: string,
  meter: Meter,
  projectId: string | null = null,
): Promise<number> {
  const scope = scopeFor(meter, projectId);
  const rows = await tx`
    SELECT COALESCE(sum(quantity), 0)::bigint AS used FROM usage_meter_events
    WHERE customer_id = ${customerId}::uuid AND meter = ${meter}
      AND (${scope}::uuid IS NULL OR project_id = ${scope}::uuid)
      AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  return Number(rows[0].used);
}

/** Fail closed: throws UsageCapExceededError when the meter is at or over its cap. Takes the meter lock. */
export async function assertWithinCap(
  tx: SqlClient,
  customerId: string,
  meter: Meter,
  projectId: string | null = null,
): Promise<{ used: number; limit: number }> {
  const scope = scopeFor(meter, projectId);
  await lockMeter(tx, customerId, meter, scope);
  const used = await usedThisMonth(tx, customerId, meter, scope);
  const { limit } = BETA_CAPS[meter];
  if (used >= limit) throw new UsageCapExceededError(meter, used, limit);
  return { used, limit };
}

export async function recordUsage(
  tx: SqlClient,
  customerId: string,
  meter: Meter,
  quantity: number,
  source: string,
  projectId: string | null = null,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  const scope = BETA_CAPS[meter].scope === "account" ? projectId : scopeFor(meter, projectId);
  await lockMeter(tx, customerId, meter, BETA_CAPS[meter].scope === "account" ? null : scope);
  await tx`
    INSERT INTO usage_meter_events (customer_id, project_id, meter, quantity, source)
    VALUES (${customerId}::uuid, ${scope}::uuid, ${meter}, ${quantity}, ${source})
  `;
}

/** Usage vs cap for every meter: account meters once, project meters for the given project. */
export async function usageSummary(tx: SqlClient, customerId: string, projectId: string | null) {
  const out: { meter: Meter; scope: "account" | "project"; used: number; limit: number; exceeded: boolean }[] = [];
  for (const meter of METERS) {
    const { limit, scope } = BETA_CAPS[meter];
    if (scope === "project" && !projectId) continue;
    const used = await usedThisMonth(tx, customerId, meter, scope === "project" ? projectId : null);
    out.push({ meter, scope, used, limit, exceeded: used >= limit });
  }
  return out;
}
