import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { getNwsJobStatus, sendNwsJob } from "@/lib/nws/job";

type Ctx = { params: Promise<{ projectId: string }> };

function fail(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const msg = error instanceof Error ? error.message : "";
  if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
  if (msg === "NO_ACTIVE_CONSENT") return NextResponse.json({ error: msg }, { status: 409 });
  if (msg === "NOT_FOUND") return NextResponse.json({ error: msg }, { status: 404 });
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** DC-06: status of the job sent to NWS, including NWS's receipt once recorded. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await getNwsJobStatus(projectId), { headers: { "cache-control": "no-store" } });
  } catch (error) { return fail(error, "NWS_JOB_READ_FAILED"); }
}

/** DC-06: send (or re-send, idempotently) the full job for the current authorized design. Refused without consent. */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await sendNwsJob(projectId), { status: 201 });
  } catch (error) { return fail(error, "NWS_JOB_SEND_FAILED"); }
}
