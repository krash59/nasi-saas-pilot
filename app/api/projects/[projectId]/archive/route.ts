import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveProject } from "@/lib/account/export";
import { getProjectForCustomer } from "@/lib/design/repository";

type Ctx = { params: Promise<{ projectId: string }> };
const schema = z.object({ confirmed: z.literal(true) }).strict();

/** Archive a project; its data is purged 90 days later (RET_D01/RET_D02). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    schema.parse(await req.json());
    return NextResponse.json({ project: await archiveProject(projectId) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "NOT_FOUND") return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: "ARCHIVE_FAILED" }, { status: 500 });
  }
}
