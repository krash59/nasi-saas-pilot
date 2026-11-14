import { NextResponse } from "next/server";
import { createProject } from "@/lib/tenant/customer";
import { z } from "zod";

const bodySchema = z.object({ name: z.string().min(1).max(200) }).strict();

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const { name } = bodySchema.parse(json);
    const rows = await createProject(name);
    const project = Array.isArray(rows) ? rows[0] : rows;
    return NextResponse.json({ project });
  } catch (e) {
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_PROJECT_REQUEST" }, { status: 400 });
    }
    if (e instanceof Error && e.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    return NextResponse.json({ error: "PROJECT_CREATE_FAILED" }, { status: 500 });
  }
}
