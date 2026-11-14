import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { acceptStorySet, getStorySet } from "@/lib/design/stories";
import { isAgentRequest } from "@/lib/security/agent";

type Ctx = { params: Promise<{ projectId: string }> };
const fail = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : "";
  if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
  if (["DIR_NOT_APPROVED", "DIR_HAS_NO_FEATURES", "STORY_REVIEW_MISMATCH_OR_MISSING"].includes(message)) return NextResponse.json({ error: message }, { status: 409 });
  return NextResponse.json({ error: fallback }, { status: 500 });
};

/** BDD_F07_01: DIR -> Agile/BDD exit artifact (AI_DRAFT stories + Gherkin) for customer review. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    if (!z.string().uuid().safeParse(projectId).success || !(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ storySet: await getStorySet(projectId) });
  } catch (error) { return fail(error, "STORY_SET_FAILED"); }
}

/** HITL: customer accepts the exact story set reviewed -> Kanban ready. Agents are refused (BDD_F08_01). */
export async function POST(req: Request, ctx: Ctx) {
  if (isAgentRequest(req.headers)) return NextResponse.json({ error: "AGENT_HITL_FORBIDDEN" }, { status: 403 });
  try {
    const { projectId } = await ctx.params;
    if (!z.string().uuid().safeParse(projectId).success || !(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const body = z.object({ confirmed: z.literal(true), reviewedStories: z.array(z.record(z.unknown())).min(1) }).strict().safeParse(await req.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "EXPLICIT_STORY_REVIEW_REQUIRED" }, { status: 400 });
    return NextResponse.json(await acceptStorySet(projectId, body.data.reviewedStories), { status: 201 });
  } catch (error) { return fail(error, "STORY_ACCEPT_FAILED"); }
}
