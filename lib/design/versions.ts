import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * DC-03 design iterations. "Revise" (from the Summary, DIR or stories page) archives the current round as an immutable
 * version (design_versions is append-only), voids any test-build authorization for it, and reopens the design chat with
 * the approved summary as the starting point. dir_drafts / story_sets keep one row per project (NWS's pinned reader
 * needs exactly one), so the old round lives only in design_versions; nothing is overwritten.
 */
export async function reviseDesign(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const project = (await tx`SELECT id, design_version FROM projects
      WHERE id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid FOR UPDATE`)[0] as { id: string; design_version: number } | undefined;
    if (!project) throw new Error("NOT_FOUND");
    const summary = (await tx`SELECT fields, status, approved_at FROM design_summaries WHERE project_id = ${projectId}::uuid FOR UPDATE`)[0];
    if (!summary || summary.status !== "approved") throw new Error("NOTHING_TO_REVISE");
    const dir = (await tx`SELECT content, status, approved_at, approved_by, source_approved_at,
        encode(digest(content::text, 'sha256'), 'hex') AS sha
      FROM dir_drafts WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid FOR UPDATE`)[0];
    const stories = (await tx`SELECT stories, status, dir_sha256, generated_at, accepted_at, accepted_by
      FROM story_sets WHERE project_id = ${projectId}::uuid FOR UPDATE`)[0];
    const voided = await tx`UPDATE implementation_consents SET revoked_at = now()
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND revoked_at IS NULL
      RETURNING id`;
    const voidedIds = voided.map((r) => String(r.id));
    const archived = (await tx`INSERT INTO design_versions (project_id, customer_id, version, summary, dir, stories, voided_consent_ids, archived_by)
      VALUES (${projectId}::uuid, ${customer.id}::uuid, ${project.design_version},
        ${JSON.stringify(summary)}::jsonb, ${dir ? JSON.stringify(dir) : null}::jsonb, ${stories ? JSON.stringify(stories) : null}::jsonb,
        ${voidedIds}::uuid[], ${customer.clerk_user_id})
      RETURNING version, archived_at`)[0];
    // The app role may not delete story sets (migration 015 grants SELECT/INSERT/UPDATE only): reset it to an unaccepted
    // draft instead, so even an unchanged design needs its stories accepted again before any new consent.
    await tx`UPDATE story_sets SET status = 'AI_DRAFT', accepted_at = NULL, accepted_by = NULL
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`;
    await tx`DELETE FROM dir_drafts WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`;
    await tx`UPDATE design_summaries SET status = 'draft', approved_at = NULL, updated_at = now() WHERE project_id = ${projectId}::uuid`;
    const next = project.design_version + 1;
    await tx`UPDATE projects SET design_version = ${next}, lifecycle_stage = 'design_discussion'
      WHERE id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`;
    await tx`INSERT INTO design_messages (project_id, role, content, is_ai_draft)
      VALUES (${projectId}::uuid, 'assistant', ${`Version ${next} started. Version ${project.design_version} is saved and will not change. Your approved summary is the starting point: tell me what you want to change.`}, false)`;
    return { archivedVersion: archived.version as number, archivedAt: archived.archived_at, currentVersion: next, voidedConsentIds: voidedIds };
  });
}

export async function listDesignVersions(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const current = (await tx`SELECT design_version FROM projects WHERE id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid`)[0];
    const versions = await tx`SELECT version, summary, dir, stories, voided_consent_ids, archived_at
      FROM design_versions WHERE project_id = ${projectId}::uuid ORDER BY version ASC`;
    return { currentVersion: (current?.design_version as number | undefined) ?? 1, versions };
  });
}
