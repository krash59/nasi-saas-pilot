import { NextResponse } from "next/server";
import { exportCustomerData } from "@/lib/account/export";

/** BDD_F11_01: download all of the signed-in customer's data (active or within the offboarding window). */
export async function GET() {
  try {
    const bundle = await exportCustomerData();
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="nasi-export.json"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "EXPORT_WINDOW_CLOSED") return NextResponse.json({ error: message }, { status: 410 });
    return NextResponse.json({ error: "EXPORT_FAILED" }, { status: 500 });
  }
}
