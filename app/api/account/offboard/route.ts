import { NextResponse } from "next/server";
import { z } from "zod";
import { requestOffboarding } from "@/lib/account/export";

const schema = z.object({ confirmed: z.literal(true) }).strict();

/** Customer starts leaving: 30-day export window, then scheduled erasure (RET_D05). */
export async function POST(req: Request) {
  try {
    schema.parse(await req.json());
    return NextResponse.json(await requestOffboarding());
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: "OFFBOARDING_FAILED" }, { status: 500 });
  }
}
