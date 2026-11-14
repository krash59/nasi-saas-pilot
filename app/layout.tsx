import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { isDevAuthEnabled, shouldUseClerk } from "@/lib/dev-auth";
import { ClerkApiFetchProvider, LocalDevApiFetchProvider } from "@/lib/providers/use-authenticated-api-fetch";

export const metadata: Metadata = {
  title: "NWS/GAS SaaS",
  description: "AI-governed software development — Wave 1 foundation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  if (isDevAuthEnabled()) {
    return (
      <html lang="en">
        <body><LocalDevApiFetchProvider>{children}</LocalDevApiFetchProvider></body>
      </html>
    );
  }
  if (!shouldUseClerk()) {
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  }
  return (
    <ClerkProvider>
      <html lang="en">
        <body><ClerkApiFetchProvider>{children}</ClerkApiFetchProvider></body>
      </html>
    </ClerkProvider>
  );
}
