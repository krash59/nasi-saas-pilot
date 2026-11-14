/** Local-only bypass when Clerk keys are not configured. Never use in production. */

export function isClerkConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim());
}

export function isDevAuthEnabled(): boolean {
  if (isClerkConfigured()) return false;
  return process.env.NODE_ENV === "development" && process.env.ENABLE_DEV_AUTH === "1";
}

/** Skip ClerkProvider / clerkMiddleware when keys are absent (local dev and production build). */
export function shouldUseClerk(): boolean {
  return isClerkConfigured();
}

export const DEV_CLERK_USER_ID = "dev_local_user";
