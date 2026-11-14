import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { getReleaseStatus, recordCustomerReleaseDecision } from "@/lib/release/authorization";
import { isAgentRequest } from "@/lib/security/agent";

type Ctx = { params: Promise<{ projectId: string }> };
const releaseRef = z.string().regex(/^[A-Za-z0-9._-]{7,80}$/);
const schema = z.object({ confirmed: z.literal(true), releaseRef, decision: z.enum(["approved", "rejected"]) }).strict();

/** BDD_F09_01 ACT_05A Customer Release Authorization. Never grants production on its own. */
export async function POST(req: Request, ctx: Ctx) {
  // Defence in depth behind middleware: agents can never record ACT_05A (BDD_F08_01).
  if (isAgentRequest(req.headers)) return NextResponse.json({ error: "AGENT_HITL_FORBIDDEN" }, { status: 403 });
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const body = schema.parse(await req.json());
    return NextResponse.json(await recordCustomerReleaseDecision(projectId, body.releaseRef, body.decision), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "EXPLICIT_RELEASE_DECISION_REQUIRED" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "DIR_NOT_APPROVED") return NextResponse.json({ error: message }, { status: 409 });
    return NextResponse.json({ error: "RELEASE_AUTHORIZATION_FAILED" }, { status: 500 });
  }
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const ref = releaseRef.parse(new URL(req.url).searchParams.get("releaseRef"));
    return NextResponse.json(await getReleaseStatus(projectId, ref));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "RELEASE_REF_REQUIRED" }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: "RELEASE_STATUS_FAILED" }, { status: 500 });
  }
}
