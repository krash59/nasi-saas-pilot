import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { buildNwsHandoff } from "@/lib/nws/handoff";

type Ctx = { params: Promise<{ projectId: string }> };

/** BDD_F14_01 / DIR §6.2: read-only preview of the NWS/GAS adapter payload. Never sent; never asserts K. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await buildNwsHandoff(projectId), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: "NWS_HANDOFF_FAILED" }, { status: 500 });
  }
}
