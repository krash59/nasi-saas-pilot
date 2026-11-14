import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { isClerkConfigured, isDevAuthEnabled } from "@/lib/dev-auth";

export default function HomePage() {
  const devAuth = isDevAuthEnabled();
  const clerkUi = isClerkConfigured() && !devAuth;
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>NWS/GAS SaaS</h1>
      <p>Wave 1: invite-only sign-in, customer account, multi-project foundation.</p>
      {!clerkUi && (
        <p style={{ background: "#fef3c7", padding: "0.5rem" }}>
          Local dev auth (Clerk not configured). <Link href="/dashboard">Go to dashboard</Link>
        </p>
      )}
      {clerkUi && (
        <>
          <SignedOut>
            <SignInButton mode="modal">
              <button type="button">Sign in</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <p>
              <Link href="/dashboard">Go to dashboard</Link>
            </p>
            <UserButton />
          </SignedIn>
        </>
      )}
    </main>
  );
}
