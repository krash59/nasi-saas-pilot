import { createHash } from "node:crypto";
import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * DC-06: the full job NWS needs to build, sent after the customer's test-build authorization:
 * approved DIR content, the accepted stories with their acceptance tests, and the consent with its scope.
 * The job is canonical JSON with a SHA-256 digest; NWS records a receipt bound to that digest, which the app reads back.
 * Production is always excluded. Without an active consent for the current approved DIR and accepted stories: refused.
 */
export const NWS_JOB_FORMAT = "nasi-nws-job-v1";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export async function sendNwsJob(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const p = (await tx`SELECT id, name, design_version FROM projects WHERE id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`)[0];
    if (!p) throw new Error("NOT_FOUND");
    const dir = (await tx`SELECT content, approved_at, approved_by, encode(digest(content::text, 'sha256'), 'hex') AS sha
      FROM dir_drafts WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND status = 'approved' AND approved_at IS NOT NULL`)[0];
    if (!dir) throw new Error("NO_ACTIVE_CONSENT");
    const set = (await tx`SELECT stories, accepted_at, accepted_by, dir_sha256 FROM story_sets
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND status = 'accepted' AND dir_sha256 = ${dir.sha as string}`)[0];
    const consent = (await tx`SELECT id, implementation_scope, granted_at, expires_at, approved_by FROM implementation_consents
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND revoked_at IS NULL AND expires_at > now()
        AND dir_sha256 = ${dir.sha as string} ORDER BY granted_at DESC LIMIT 1`)[0];
    if (!set || !consent) throw new Error("NO_ACTIVE_CONSENT");
    const job = {
      format: NWS_JOB_FORMAT,
      project: { id: p.id, name: p.name, design_version: p.design_version },
      tenant_id: customer.id,
      dir: { sha256: dir.sha, approved_at: iso(dir.approved_at), approved_by: dir.approved_by, content: dir.content },
      stories: { dir_sha256: set.dir_sha256, accepted_at: iso(set.accepted_at), accepted_by: set.accepted_by, items: set.stories },
      consent: { id: consent.id, scope: consent.implementation_scope, granted_at: iso(consent.granted_at), expires_at: iso(consent.expires_at),
        approved_by: consent.approved_by, production: false },
    };
    const canonical = canonicalJson(job);
    const digest = sha256Hex(canonical);
    await tx`INSERT INTO nws_handoffs (project_id, customer_id, consent_id, design_version, job, job_sha256, sent_by)
      VALUES (${projectId}::uuid, ${customer.id}::uuid, ${consent.id as string}::uuid, ${p.design_version as number},
        ${canonical}::jsonb, ${digest}, ${customer.clerk_user_id})
      ON CONFLICT (consent_id, job_sha256) DO NOTHING`;
    const row = (await tx`SELECT id, job_sha256, sent_at, received_at, receipt FROM nws_handoffs
      WHERE consent_id = ${consent.id as string}::uuid AND job_sha256 = ${digest}`)[0];
    return { handoff: row, job, sentToNws: true, productionIncluded: false };
  });
}

/** Latest handoff for this project, with NWS's receipt when it has been recorded (read-back). */
export async function getNwsJobStatus(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`SELECT h.id, h.design_version, h.job_sha256, h.sent_at, h.received_at, h.receipt,
        (c.revoked_at IS NULL AND c.expires_at > now()) AS consent_current
      FROM nws_handoffs h JOIN implementation_consents c ON c.id = h.consent_id
      WHERE h.project_id = ${projectId}::uuid AND h.customer_id = ${customer.id}::uuid ORDER BY h.sent_at DESC LIMIT 1`;
    return { handoff: rows[0] ?? null };
  });
}
