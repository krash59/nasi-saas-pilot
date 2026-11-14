import { createPgSql, type SqlQuery } from "@/lib/db/pg-sql";

export type SqlClient = SqlQuery;

/** Tenant context and all protected queries must share one transaction/connection. */
export function getSql(connectionString: string): SqlClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return createPgSql(connectionString);
}

/** Set tenant context for RLS policies (must run before tenant queries). */
export async function withCustomerContext<T>(
  sql: SqlClient,
  customerId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  if (!sql.withTenant) throw new Error("TENANT_TRANSACTION_NOT_SUPPORTED");
  return sql.withTenant(customerId, fn);
}
