import { auth } from "@clerk/nextjs/server";
import { getSql, withCustomerContext } from "@/lib/db/client";
import { DEV_CLERK_USER_ID, isDevAuthEnabled } from "@/lib/dev-auth";
import { headers } from "next/headers";
import { authenticatePilotBearer } from "@/lib/providers/clerk-pilot";

export type CustomerRow = { id: string; clerk_user_id: string };

async function resolveUserId(): Promise<string> {
  if (process.env.NASI_PROVIDER_MODE === "synthetic-pilot") {
    const authorization = (await headers()).get("authorization");
    if (authorization) return authenticatePilotBearer(authorization);
    if (isDevAuthEnabled()) throw new Error("UNAUTHENTICATED");
  }
  if (isDevAuthEnabled()) return DEV_CLERK_USER_ID;
  const { userId } = await auth();
  if (!userId) throw new Error("UNAUTHENTICATED");
  return userId;
}

/** Resolve or create customer row for signed-in Clerk user. */
export async function requireCustomer(): Promise<CustomerRow> {
  const userId = await resolveUserId();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL not configured");
  }

  const sql = getSql(dbUrl);

  const registered = await sql`
    SELECT register_customer(${userId}::text) AS id
  `;
  return { id: registered[0].id as string, clerk_user_id: userId };
}

export async function listProjectsForCurrentCustomer() {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    return tx`
      SELECT id, name, status, created_at
      FROM projects
      ORDER BY created_at DESC
    `;
  });
}

export async function createProject(name: string) {
  const customer = await requireCustomer();
  const sql = getSql(process.env.DATABASE_URL!);
  return withCustomerContext(sql, customer.id, async (tx) => {
    return tx`
      INSERT INTO projects (customer_id, name)
      VALUES (${customer.id}, ${name})
      RETURNING id, name, status, created_at
    `;
  });
}
