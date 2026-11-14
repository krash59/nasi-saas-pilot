import type { SqlClient } from "@/lib/db/client";

export type SecurityEventType = "PROJECT_ACCESS_DENIED" | "DATA_EXPORTED" | "OFFBOARDING_REQUESTED" | "PROJECT_ARCHIVED";

/**
 * Append a security audit event for the current tenant. Must run inside the tenant
 * transaction (withCustomerContext) so RLS ties the row to the requester.
 */
export async function recordSecurityEvent(
  tx: SqlClient,
  customerId: string,
  eventType: SecurityEventType,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await tx`
    INSERT INTO security_audit_events (customer_id, event_type, resource_type, resource_id)
    VALUES (${customerId}::uuid, ${eventType}, ${resourceType}, ${resourceId})
  `;
}
