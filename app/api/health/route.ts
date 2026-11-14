import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    wave: 1,
    service: "nws-gas-saas-app",
  });
}
