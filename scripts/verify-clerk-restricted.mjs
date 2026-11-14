#!/usr/bin/env node
/**
 * Verify Clerk instance sign-up mode (invite-only / restricted) via Backend API.
 * Requires CLERK_SECRET_KEY. DIR §4.3
 */
const key = process.env.CLERK_SECRET_KEY;
if (!key) {
  console.log(
    JSON.stringify({
      pass: false,
      status: "NOT_VERIFIED",
      reason: "CLERK_SECRET_KEY not set — configure .env.local for live verification",
      codeChecks: {
        middleware: "clerkMiddleware auth.protect on non-public routes",
        signUpUrl: "NEXT_PUBLIC_CLERK_SIGN_UP_URL points to /sign-in",
      },
    }),
  );
  process.exit(2);
}

const res = await fetch("https://api.clerk.com/v1/instance", {
  headers: { Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  console.log(
    JSON.stringify({
      pass: false,
      status: "FAIL",
      httpStatus: res.status,
      body: await res.text(),
    }),
  );
  process.exit(1);
}

const data = await res.json();
const signUpMode =
  data?.user_settings?.sign_up_mode ??
  data?.sign_up_mode ??
  data?.public_metadata?.sign_up_mode;

const restricted = signUpMode === "restricted" || signUpMode === "invite_only";

console.log(
  JSON.stringify(
    {
      pass: restricted,
      status: restricted ? "PASS" : "FAIL",
      signUpMode: signUpMode ?? "unknown",
      instanceId: data?.id,
      evidence: "Clerk Backend API GET /v1/instance",
    },
    null,
    2,
  ),
);

process.exit(restricted ? 0 : 1);
