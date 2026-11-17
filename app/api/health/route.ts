import { NextResponse } from "next/server";

export async function GET() {
  // The git commit this deployment was built from (Vercel system variable; public repository, not a secret), so the
  // deploy gate can tell a new deployment from a healthy older one. Added only on Vercel: outside it the reply stays
  // exactly {ok, wave, service}, which the NWS product-build health probe requires.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA;
  return NextResponse.json({
    ok: true,
    wave: 1,
    service: "nws-gas-saas-app",
    ...(commit ? { commit } : {}),
  });
}
