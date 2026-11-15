import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isDevAuthEnabled, shouldUseClerk } from "@/lib/dev-auth";
import { isAgentRequest, isHitlRoute } from "@/lib/security/agent";

// Stripe authenticates the exact raw body with its own webhook signature.
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/api/health", "/api/providers/stripe/webhook"]);

function isPilotApiRoute(pathname: string): boolean {
  // Customer product APIs added in rounds 7-12 (stories, usage, agent status, release authorization, NWS handoff,
  // archive, account export/offboard/break-glass) must accept the same validated pilot bearer as the original routes.
  return ["/api/billing/entitlement", "/api/providers/resend/test", "/api/projects",
    "/api/account/export", "/api/account/offboard", "/api/account/break-glass"].includes(pathname) ||
    /^\/api\/projects\/[0-9a-f-]{36}\/(?:design\/(?:messages|summary)|dir(?:\/approve)?|stories|usage|agent-status|release-authorization|nws-handoff|archive)$/i.test(pathname);
}

const clerkHandler = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
}, { jwtKey: process.env.CLERK_JWT_KEY || undefined });

export default function middleware(req: NextRequest, event: unknown) {
  // BDD_F08_01: agent identities are refused on every HITL approval route, in every auth mode,
  // before any handler runs (so no approval record can be created).
  if (isAgentRequest(req.headers) && isHitlRoute(req.method, req.nextUrl.pathname)) {
    return NextResponse.json({ error: "AGENT_HITL_FORBIDDEN" }, { status: 403 });
  }
  // Liveness must survive identity-provider outages. The exact webhook route
  // authenticates its raw payload independently and must also accept callbacks
  // without a browser session. Protected product APIs still use Clerk below.
  if (req.nextUrl.pathname === "/api/health" || req.nextUrl.pathname === "/api/providers/stripe/webhook") {
    return NextResponse.next();
  }
  if (!shouldUseClerk() || isDevAuthEnabled()) {
    return NextResponse.next();
  }
  // These known pilot APIs validate bearer signature, expiry and current session
  // in requireCustomer() in the Node runtime, before any protected operation.
  if (process.env.NASI_PROVIDER_MODE === "synthetic-pilot" && isPilotApiRoute(req.nextUrl.pathname) &&
      req.headers.has("authorization")) {
    return NextResponse.next();
  }
  // Missing credentials need no identity-provider request or browser handshake.
  // Present credentials still require Clerk's signature/session validation.
  if (req.nextUrl.pathname.startsWith("/api/") && !req.headers.get("authorization") &&
      !req.cookies.getAll().some(cookie => cookie.name === "__session" || cookie.name.startsWith("__session_"))) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return clerkHandler(req, event as Parameters<typeof clerkHandler>[1]);
}

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
