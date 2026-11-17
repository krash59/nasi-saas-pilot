import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    wave: 1,
    service: "nws-gas-saas-app",
    // The git commit this deployment was built from (Vercel system variable; public repository, not a secret).
    // The deploy gate compares it, so a healthy older deployment cannot pass for a new one.
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
