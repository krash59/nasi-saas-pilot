import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isDevAuthEnabled, shouldUseClerk } from "@/lib/dev-auth";

// Stripe authenticates the exact raw body with its own webhook signature.
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/api/health", "/api/providers/stripe/webhook"]);

function isPilotApiRoute(pathname: string): boolean {
  return ["/api/billing/entitlement", "/api/providers/resend/test", "/api/projects"].includes(pathname) ||
    /^\/api\/projects\/[0-9a-f-]{36}\/(?:design\/(?:messages|summary)|dir(?:\/approve)?)$/i.test(pathname);
}

const clerkHandler = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
}, { jwtKey: process.env.CLERK_JWT_KEY || undefined });

export default function middleware(req: NextRequest, event: unknown) {
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
