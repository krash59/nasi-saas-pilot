import { NextResponse } from "next/server";
import { getProjectForCustomer } from "@/lib/design/repository";
import { generateDirDraft, getDirDraft } from "@/lib/design/dir-repository";
import { z } from "zod";

type Ctx = { params: Promise<{ projectId: string }> };

async function handle(ctx: Ctx, generate: boolean) {
  try {
    const { projectId } = await ctx.params;
    if (!z.string().uuid().safeParse(projectId).success) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (!(await getProjectForCustomer(projectId))) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const draft = generate ? await generateDirDraft(projectId) : await getDirDraft(projectId);
    return NextResponse.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (["DESIGN_SUMMARY_NOT_APPROVED", "FIELDS_NOT_CONFIRMED"].includes(message)) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: "DIR_REQUEST_FAILED" }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: Ctx) { return handle(ctx, false); }
export async function POST(_req: Request, ctx: Ctx) { return handle(ctx, true); }
