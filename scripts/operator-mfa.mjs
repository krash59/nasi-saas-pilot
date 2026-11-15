#!/usr/bin/env node
// S02_01 operator MFA (RFC 6238 TOTP) - owner tool. Connects with OPERATOR_MFA_ADMIN_URL (DB owner or a member of
// nasi_operator_mfa_admin; never printed).
//   enroll <operator_login> [--store]  new 160-bit secret enrolled in the DB; prints the otpauth:// URI ONCE so the
//                                      operator can add it to an authenticator app. --store also keeps the secret in
//                                      ~/.config/nasi/pilot-providers/operator-mfa/<login>.json (mode 600) - for the
//                                      synthetic pilot operators used by automated checks only.
//   code <operator_login>              current 6-digit code from a --store'd secret (synthetic pilot operators only)
// Exported helpers are used by tests and the operator CLIs.
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const STORE = join(homedir(), ".config/nasi/pilot-providers/operator-mfa");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 6238 TOTP, HMAC-SHA1, 30 s step. */
export function totp(secret, { time = Date.now() / 1000, step = 30, digits = 6 } = {}) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / step)));
  const h = createHmac("sha1", secret).update(counter).digest();
  const o = h[19] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function storedSecret(login) {
  return Buffer.from(JSON.parse(readFileSync(join(STORE, `${login}.json`), "utf8")).secret_hex, "hex");
}

export async function enroll(connectionString, login, { store = false } = {}) {
  if (!/^[a-z_][a-z0-9_]{1,62}$/.test(login ?? "")) throw new Error("INVALID_LOGIN");
  const secret = randomBytes(20);
  const c = new pg.Client({ connectionString }); await c.connect();
  try { await c.query("SELECT operator_mfa_enroll($1, $2)", [login, secret]); } finally { await c.end(); }
  if (store) {
    mkdirSync(STORE, { recursive: true, mode: 0o700 });
    const f = join(STORE, `${login}.json`);
    writeFileSync(f, JSON.stringify({ login, secret_hex: secret.toString("hex"), purpose: "synthetic pilot operator for automated checks" }), { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return { login, uri: `otpauth://totp/NASI:${login}?secret=${base32(secret)}&issuer=NASI&algorithm=SHA1&digits=6&period=30` };
}

/** Split "--otp <code>" out of CLI arguments. */
export function splitOtp(argv) {
  const a = [...(argv ?? [])]; const i = a.indexOf("--otp");
  if (i < 0) return { otp: null, rest: a };
  const otp = a[i + 1]; a.splice(i, 2); return { otp, rest: a };
}

/** Record an MFA refusal (the gate's own write is rolled back with its error). Best effort; never hides the error. */
export async function noteMfaDenial(client, error) {
  if (String(error?.message).includes("OPERATOR_MFA_REQUIRED")) await client.query("SELECT operator_mfa_note_denial()").catch(() => {});
  throw error;
}

/** Open the 10-minute MFA session for the login behind `client` (used by operator CLIs before privileged calls). */
export async function verifyOtp(client, code) {
  // A still-open session needs no new code (codes are single use; re-sending would count toward the lockout).
  if ((await client.query("SELECT operator_mfa_session_active() AS a")).rows[0].a) return { mfa: "SESSION_ACTIVE" };
  const r = (await client.query("SELECT operator_mfa_verify($1) AS j", [code])).rows[0].j;
  if (r.denied) throw new Error(r.denied);
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, login, flag] = process.argv.slice(2);
  const run = async () => {
    if (cmd === "enroll") {
      const url = process.env.OPERATOR_MFA_ADMIN_URL;
      if (!url) throw new Error("OPERATOR_MFA_ADMIN_URL is BLANK");
      const r = await enroll(url, login, { store: flag === "--store" });
      console.log(`Enrolled ${r.login}. Add this to your authenticator app now (shown once):\n${r.uri}`);
    } else if (cmd === "code") {
      console.log(totp(storedSecret(login)));
    } else throw new Error("USAGE: enroll <login> [--store] | code <login>");
  };
  run().catch(e => { console.error(/^[A-Z_ ]+/.test(e.message) ? e.message : "OPERATOR_MFA_FAILED"); process.exit(1); });
}
