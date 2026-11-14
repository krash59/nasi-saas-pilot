import { NextResponse } from "next/server";
import { getProjectForCustomer } from "@/lib/design/repository";
import { getUsageForProject } from "@/lib/usage/repository";

type Ctx = { params: Promise<{ projectId: string }> };

/** BDD_F10_01: the customer can see usage against each approved beta cap. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ period: "calendar_month_utc", usage: await getUsageForProject(projectId) });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    return NextResponse.json({ error: "USAGE_READ_FAILED" }, { status: 500 });
  }
}
