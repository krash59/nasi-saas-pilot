import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * DIR §5.2 DIR -> Agile/BDD exit artifact (BDD_F07_01): stories + Gherkin acceptance criteria derived from the
 * customer-approved DIR. Deterministic (no model call, no invented requirements): one story per must-have feature
 * line, marked AI_DRAFT until the customer accepts the exact set. Acceptance moves the project to kanban.
 */
export type Story = { id: string; as_a: string; i_want: string; so_that: string; gherkin: string };
type Section = { key?: string; content?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const firstLine = (s: string) => s.split(/\r?\n/).map(l => l.replace(/^[-*•\d.)\s]+/, "").trim()).find(Boolean) ?? "";

export function storiesFromDir(content: unknown): Story[] {
  const sections = (content as { sections?: Section[] } | null)?.sections ?? [];
  const get = (k: string) => text(sections.find(s => s?.key === k)?.content);
  const persona = firstLine(get("users_personas")) || "customer user";
  const why = firstLine(get("problem_statement"));
  const features = get("must_have_features").split(/\r?\n|;/).map(l => l.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
  if (!features.length) throw new Error("DIR_HAS_NO_FEATURES");
  return features.slice(0, 50).map((f, i) => ({
    id: `ST${String(i + 1).padStart(2, "0")}`,
    as_a: persona,
    i_want: f,
    so_that: why || "the approved DIR problem is solved",
    gherkin: [
      `Feature: ${f}`,
      `  Scenario: ${persona} uses ${f}`,
      `    Given ${persona} is signed in to the delivered application`,
      `    When they use "${f}"`,
      `    Then the behaviour described for it in the approved DIR is met`,
      `    And nothing listed as out of scope in the DIR is introduced`,
    ].join("\n"),
  }));
}

/** Returns the current story set, generating or regenerating the AI_DRAFT when the approved DIR changed. */
export async function getStorySet(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const dir = (await tx`SELECT content, encode(digest(content::text, 'sha256'), 'hex') AS sha FROM dir_drafts
      WHERE project_id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid AND status = 'approved' AND approved_at IS NOT NULL`)[0];
    if (!dir) throw new Error("DIR_NOT_APPROVED");
    const current = (await tx`SELECT project_id, dir_sha256, stories, status, generated_at, accepted_at, accepted_by
      FROM story_sets WHERE project_id = ${projectId}::uuid`)[0];
    if (current && current.dir_sha256 === dir.sha) return current;
    const stories = storiesFromDir(dir.content);
    const rows = await tx`INSERT INTO story_sets (project_id, customer_id, dir_sha256, stories)
      VALUES (${projectId}::uuid, ${customer.id}::uuid, ${dir.sha as string}, ${JSON.stringify(stories)}::jsonb)
      ON CONFLICT (project_id) DO UPDATE SET dir_sha256 = EXCLUDED.dir_sha256, stories = EXCLUDED.stories,
        status = 'AI_DRAFT', generated_at = now(), accepted_at = NULL, accepted_by = NULL
      RETURNING project_id, dir_sha256, stories, status, generated_at, accepted_at, accepted_by`;
    return rows[0];
  });
}

/** HITL: the customer accepts the exact stories they reviewed. Moves the project to kanban (DB-gated). */
export async function acceptStorySet(projectId: string, reviewedStories: unknown) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async tx => {
    const rows = await tx`UPDATE story_sets s SET status = 'accepted', accepted_at = COALESCE(s.accepted_at, now()),
        accepted_by = COALESCE(s.accepted_by, ${customer.clerk_user_id})
      FROM dir_drafts d
      WHERE s.project_id = ${projectId}::uuid AND s.customer_id = ${customer.id}::uuid
        AND d.project_id = s.project_id AND d.customer_id = ${customer.id}::uuid AND d.status = 'approved' AND d.approved_at IS NOT NULL
        AND s.dir_sha256 = encode(digest(d.content::text, 'sha256'), 'hex')
        AND s.stories = ${JSON.stringify(reviewedStories)}::jsonb
      RETURNING s.project_id, s.status, s.accepted_at`;
    if (!rows.length) throw new Error("STORY_REVIEW_MISMATCH_OR_MISSING");
    await tx`UPDATE projects SET lifecycle_stage = 'kanban' WHERE id = ${projectId}::uuid AND customer_id = ${customer.id}::uuid
      AND stage_ordinal(lifecycle_stage) < stage_ordinal('kanban')`;
    return { ...rows[0], implementationAuthorized: false };
  });
}
