import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { getAgentStatus } from "@/lib/agent/status";

type Ctx = { params: Promise<{ projectId: string }> };

/** BDD_F08_02 / BDD_F15_01: agent halts, verification packages and staging promotions for the owner. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await getAgentStatus(projectId));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: "AGENT_STATUS_FAILED" }, { status: 500 });
  }
}
