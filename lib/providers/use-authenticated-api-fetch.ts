"use client";

import { useAuth } from "@clerk/nextjs";
import { createContext, createElement, ReactNode, useCallback, useContext, useMemo } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
const ApiFetchContext = createContext<ApiFetch | null>(null);

function createApiFetch(getToken?: () => Promise<string | null>): ApiFetch {
  return async (path, init = {}) => {
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/")) {
      throw new Error("PRODUCT_API_PATH_REQUIRED");
    }

    const headers = new Headers(init.headers);
    if (getToken) {
      const token = await getToken();
      if (token) {
        const payload = token.split(".")[1];
        if (payload) {
          try {
            const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
            const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
            const claims = JSON.parse(atob(padded)) as { nbf?: unknown; iat?: unknown };
            const activeAt = Math.max(
              typeof claims.nbf === "number" ? claims.nbf : 0,
              typeof claims.iat === "number" ? claims.iat : 0,
            );
            if (activeAt > 0) {
              const delayMs = activeAt * 1000 - Date.now() + 250;
              if (delayMs > 60_000) throw new Error("SESSION_TOKEN_ACTIVATION_DELAY_TOO_LONG");
              if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          } catch (error) {
            if (error instanceof Error && error.message === "SESSION_TOKEN_ACTIVATION_DELAY_TOO_LONG") throw error;
          }
        }
        headers.set("Authorization", `Bearer ${token}`);
      }
    }

    return fetch(`${target.pathname}${target.search}`, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  };
}

/** Local-only provider: API routes resolve the configured local development identity server-side. */
export function LocalDevApiFetchProvider({ children }: { children: ReactNode }) {
  const fetchApi = useMemo(() => createApiFetch(), []);
  return createElement(ApiFetchContext.Provider, { value: fetchApi }, children);
}

/** Clerk provider bridge: product API calls carry Clerk's current signed session token. */
export function ClerkApiFetchProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const fetchApi = useCallback(createApiFetch(getToken), [getToken]);
  return createElement(ApiFetchContext.Provider, { value: fetchApi }, children);
}

export function useAuthenticatedApiFetch(): ApiFetch {
  const fetchApi = useContext(ApiFetchContext);
  // Keep static rendering and misconfigured builds from crashing. With no
  // provider, requests carry no bearer token and server authorization fails closed.
  return fetchApi ?? fallbackApiFetch;
}

const fallbackApiFetch = createApiFetch();
