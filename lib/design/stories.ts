import { getSql, withCustomerContext } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";

/**
 * DIR §5.2 DIR -> Agile/BDD exit artifact (BDD_F07_01): stories + Gherkin acceptance criteria derived from the
 * customer-approved DIR. Deterministic (no model call, no invented requirements): one story per must-have feature
 * line, marked AI_DRAFT until the customer accepts the exact set. Acceptance moves the project to kanban.
 */
export type Story = {
  id: string;
  as_a: string;
  i_want: string;
  so_that: string;
  gherkin: string;
  /** DC-02: where each part came from in the approved DIR, and the GP1P action it can feed. */
  dir_refs?: { feature: string; persona: string; benefit: string };
  gp1p_action_id?: string;
};
type Section = { key?: string; content?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clean = (l: string) => l.replace(/^[-*\u2022\d.)\s]+/, "").replace(/\*\*/g, "").trim();
/** Deterministic list rule: if the text has bullet or numbered lines, only those are items (intro and closing sentences
 * are explanation, not features); otherwise every line or ";"-separated part is an item. */
const BULLET = /^\s*(?:[-*\u2022]|\d+[.)])\s+/;
const items = (s: string) => {
  const bullets = s.split(/\r?\n/).filter((l) => BULLET.test(l));
  return bullets.length ? bullets.map(clean).filter(Boolean) : lines(s);
};
const lines = (s: string) => s.split(/\r?\n|;/).map(clean).filter(Boolean);
const STOP = new Set(["the", "and", "for", "with", "that", "this", "their", "they", "them", "from", "into", "have", "will",
  "can", "are", "was", "who", "our", "your", "you", "all", "any", "not", "but", "use", "using", "able", "need", "needs", "want"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w))
  .map(w => w.replace(/(ies)$/, "y").replace(/(s)$/, "")) ?? []);
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(w => b.has(w)).length;

/** Personas: one per line, or a comma/"and" list on one line. "Receptionist: books visits" -> name + description. */
function personasFrom(raw: string) {
  let items = lines(raw);
  if (items.length === 1) items = items[0].split(/,|\band\b/).map(clean).filter(Boolean);
  return items.slice(0, 20).map((item, i) => {
    const m = item.match(/^(.+?)\s*(?::|\s[-\u2013\u2014]\s|\()\s*(.*?)\)?$/);
    const name = (m ? m[1] : item).trim();
    return { name, words: words(item), ref: `users_personas[${i + 1}]` };
  });
}

/** "Book online - so that patients can book 24/7" / "X so that Y" / "X: Y" -> feature + its own stated benefit. */
function featureFrom(item: string) {
  const m = item.match(/^(.+?)\s*(?:[-\u2013\u2014,]\s*)?\bso\s+(?:that\s+)?(.+)$/i) ?? item.match(/^(.+?)\s*(?::|\s[-\u2013\u2014]\s)\s*(.+)$/);
  return m ? { feature: m[1].trim(), benefit: m[2].trim().replace(/\.$/, "") } : { feature: item.replace(/\.$/, ""), benefit: "" };
}

const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\r?\n/).map(clean).map(x => x.replace(/\.$/, "")).filter(x => x.length > 3);
const MEASURABLE = /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec|seconds?|minutes?|mins?|hours?|days?|%|percent|users?|requests?)\b/i;

/**
 * DIR §5.2 DIR -> Agile/BDD exit artifact (BDD_F07_01), improved for DC-02: deterministic (no model call, nothing
 * invented). Each must-have feature becomes one story with ONE persona (best word match to the feature, else rotating)
 * and ONE specific benefit (the feature's own "so that", else the closest problem-statement sentence), concrete
 * Given/When/Then tests with observable outcomes, and trace references to the DIR lines plus a GP1P action ID.
 */
export function storiesFromDir(content: unknown): Story[] {
  const sections = (content as { sections?: Section[] } | null)?.sections ?? [];
  const get = (k: string) => text(sections.find(s => s?.key === k)?.content);
  const features = items(get("must_have_features")).map(featureFrom).slice(0, 50);
  if (!features.length) throw new Error("DIR_HAS_NO_FEATURES");
  const personas = personasFrom(get("users_personas"));
  if (!personas.length) personas.push({ name: "customer user", words: new Set(), ref: "users_personas" });
  const problems = sentences(get("problem_statement"));
  const outOfScope = items(get("out_of_scope")).filter(l => !/^(none|n\/a|nothing)$/i.test(l));
  const measurable = lines(get("constraints")).filter(l => MEASURABLE.test(l));

  return features.map(({ feature, benefit }, i) => {
    const fw = words(`${feature} ${benefit}`);
    let pi = i % personas.length, best = 0;
    personas.forEach((p, j) => { const sc = overlap(fw, p.words); if (sc > best) { best = sc; pi = j; } });
    const persona = personas[pi];
    let benefitText = benefit, benefitRef = `must_have_features[${i + 1}]`;
    if (!benefitText && problems.length) {
      let bi = 0, bs = -1;
      // Match on what the feature is about, not on who uses it; the persona only breaks ties.
      const topic = new Set([...fw].filter(w => !persona.words.has(w)));
      problems.forEach((s, j) => { const sw = words(s); const sc = overlap(topic, sw) * 10 + overlap(persona.words, sw); if (sc > bs) { bs = sc; bi = j; } });
      benefitText = `this is no longer a problem: ${problems[bi].charAt(0).toLowerCase()}${problems[bi].slice(1)}`;
      benefitRef = `problem_statement[${bi + 1}]`;
    }
    if (!benefitText) { benefitText = `${feature.toLowerCase()} works as approved in the DIR`; }
    const who = persona.name;
    const limit = measurable.find(c => overlap(words(c), fw) > 0); // only a constraint about this feature
    const id = `ST${String(i + 1).padStart(2, "0")}`;
    const g = [
      `Feature: ${feature}`,
      `  Scenario: ${who} completes "${feature}"`,
      `    Given ${who} is signed in to the delivered application`,
      `    When ${who} uses "${feature}" with all required details filled in`,
      `    Then the app shows a confirmation that "${feature}" succeeded`,
      `    And the result is saved and still shown to ${who} after the page is reloaded`,
      ...(limit ? [`    And it meets the DIR constraint: ${limit}`] : []),
      `  Scenario: missing details are refused`,
      `    Given ${who} is signed in to the delivered application`,
      `    When ${who} tries "${feature}" with a required detail left empty`,
      `    Then the app says which detail is missing and nothing is saved`,
      ...(outOfScope.length ? [
        `  Scenario: out-of-scope items stay out`,
        `    Given ${who} is using "${feature}"`,
        `    Then the app does not offer "${outOfScope[i % outOfScope.length]}"`,
      ] : []),
    ].join("\n");
    return {
      id, as_a: who, i_want: feature, so_that: benefitText, gherkin: g,
      dir_refs: { feature: `must_have_features[${i + 1}]`, persona: persona.ref, benefit: benefitRef },
      gp1p_action_id: `GP1P.STORY.${id}`,
    };
  });
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
