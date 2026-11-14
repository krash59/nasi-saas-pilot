import { NextResponse } from "next/server";
import { listBreakGlassForCustomer } from "@/lib/account/break-glass";

/** Customer view of operator emergency access to their data (DIR §8.4 notification). */
export async function GET() {
  try {
    return NextResponse.json({ breakGlass: await listBreakGlassForCustomer() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    return NextResponse.json({ error: "BREAK_GLASS_READ_FAILED" }, { status: 500 });
  }
}
