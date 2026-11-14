import Link from "next/link";
import { isClerkConfigured } from "@/lib/dev-auth";
import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  if (!isClerkConfigured()) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <p>
          Clerk is not configured. <Link href="/dashboard">Continue to dashboard</Link> (local dev).
        </p>
      </main>
    );
  }
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <SignIn />
    </main>
  );
}
