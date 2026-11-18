import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { listDesignVersions, reviseDesign } from "@/lib/design/versions";

type Ctx = { params: Promise<{ projectId: string }> };

function fail(error: unknown, fallback: string) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const msg = error instanceof Error ? error.message : "";
  if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
  if (msg === "NOTHING_TO_REVISE") return NextResponse.json({ error: msg }, { status: 409 });
  if (msg === "NOT_FOUND") return NextResponse.json({ error: msg }, { status: 404 });
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** DC-03: earlier design versions (read-only). */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await listDesignVersions(projectId), { headers: { "cache-control": "no-store" } });
  } catch (error) { return fail(error, "DESIGN_VERSIONS_READ_FAILED"); }
}

/** DC-03: Revise = archive this version, void its test-build authorization, reopen the design chat. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    z.object({ action: z.literal("revise") }).strict().parse(await req.json());
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await reviseDesign(projectId), { status: 201 });
  } catch (error) { return fail(error, "DESIGN_REVISE_FAILED"); }
}
