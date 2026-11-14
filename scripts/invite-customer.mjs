#!/usr/bin/env node
// S01_01 / S01_02 (BDD_F01_01, DIR §4.1/§4.3): operator invites one customer; the invite IS the only way in.
//   1. The address is added to the Clerk allowlist (the instance is restricted: uninvited self sign-up is refused).
//   2. The Clerk user is provisioned server-side (no self sign-up path is needed).
//   3. A single-use, short-lived Clerk sign-in token is created and emailed via Resend as a magic link to
//      <APP_URL>/sign-in?__clerk_ticket=..., which Clerk's <SignIn/> redeems.
// Secrets come from the environment (CLERK_SECRET_KEY, RESEND_API_KEY, NASI_APP_URL) and are never printed;
// the link itself is only ever in the email.
//   node scripts/invite-customer.mjs <email> [--ttl-minutes 15] [--no-email]
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

async function clerk(cfg, method, path, body) {
  const r = await cfg.fetch("https://api.clerk.com/v1" + path, {
    method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Authorization: "Bearer " + cfg.clerkSecret, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

export async function inviteCustomer({ email, clerkSecret, resendKey, appUrl, ttlMinutes = 15, sendEmail = true, fetch: f = fetch }) {
  if (!EMAIL.test(email ?? "")) throw new Error("INVALID_EMAIL");
  if (!/^sk_(test|live)_/.test(clerkSecret ?? "")) throw new Error("CLERK_NOT_CONFIGURED");
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) throw new Error("INVALID_TTL");
  const app = new URL(appUrl ?? "");
  if (!["https:", "http:"].includes(app.protocol) || (app.protocol === "http:" && !["localhost", "127.0.0.1"].includes(app.hostname))) throw new Error("APP_URL_MUST_BE_HTTPS");
  if (sendEmail && !/^re_/.test(resendKey ?? "")) throw new Error("EMAIL_NOT_CONFIGURED");
  const cfg = { clerkSecret, fetch: f };

  const allow = await clerk(cfg, "POST", "/allowlist_identifiers", { identifier: email, notify: false });
  if (![200, 422].includes(allow.status)) throw new Error("ALLOWLIST_FAILED");           // 422 = already allow-listed
  let user = (await clerk(cfg, "GET", "/users?email_address=" + encodeURIComponent(email))).json?.[0];
  if (!user) {
    const made = await clerk(cfg, "POST", "/users", { email_address: [email], skip_password_requirement: true });
    if (made.status !== 200) throw new Error("USER_PROVISION_FAILED");
    user = made.json;
  }
  const tok = await clerk(cfg, "POST", "/sign_in_tokens", { user_id: user.id, expires_in_seconds: ttlMinutes * 60 });
  if (tok.status !== 200 || !tok.json?.token) throw new Error("SIGN_IN_TOKEN_FAILED");
  const link = new URL("/sign-in", app);
  link.searchParams.set("__clerk_ticket", tok.json.token);
  const result = { user_id: user.id, allowlist: allow.status === 200 ? "added" : "already", magic_link_expires_minutes: ttlMinutes, email_id: null };
  if (!sendEmail) return { ...result, link: link.toString() };   // only for callers that deliver it themselves

  const r = await f("https://api.resend.com/emails", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + resendKey, "Content-Type": "application/json",
      "Idempotency-Key": "nasi-invite-" + createHash("sha256").update(tok.json.id ?? tok.json.token).digest("hex").slice(0, 40),
    },
    body: JSON.stringify({
      from: "NASI <onboarding@resend.dev>", to: [email], subject: "Your NASI sign-in link",
      text: `You have been invited to NASI.\n\nSign in (single use, expires in ${ttlMinutes} minutes):\n${link}\n\nIf you did not expect this, ignore this email.`,
    }),
  });
  const sent = await r.json().catch(() => ({}));
  if (!r.ok || !sent.id) throw new Error("EMAIL_SEND_FAILED");
  return { ...result, email_id: sent.id };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [email, ...rest] = process.argv.slice(2);
  const i = rest.indexOf("--ttl-minutes");
  inviteCustomer({
    email, clerkSecret: process.env.CLERK_SECRET_KEY, resendKey: process.env.RESEND_API_KEY, appUrl: process.env.NASI_APP_URL,
    ttlMinutes: i >= 0 ? Number(rest[i + 1]) : 15, sendEmail: !rest.includes("--no-email"),
  })
    .then(out => { delete out.link; console.log(JSON.stringify(out)); })
    .catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : "INVITE_FAILED"); process.exit(1); });
}
