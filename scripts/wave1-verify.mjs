#!/usr/bin/env node
/**
 * Wave 1 verification orchestrator — migration, RLS integration, Clerk, audit summary.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const report = {
  token: "WAVE_1_VERIFICATION",
  executedOn: new Date().toISOString(),
  checks: {},
};

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Load .env.local if present
const envLocal = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envLocal)) {
  for (const line of fs.readFileSync(envLocal, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (dbUrl) {
  const mig = run("node", ["scripts/run-migration.mjs"], { DATABASE_URL: dbUrl });
  report.checks.migration = {
    verdict: mig.code === 0 ? "PASS" : "FAIL",
    target: dbUrl.includes("neon") ? "neon" : "postgresql",
    stdout: mig.stdout.trim(),
    stderr: mig.stderr.trim(),
  };

  const rls = run("node", ["scripts/verify-rls-integration.mjs"], {
    TEST_DATABASE_URL: dbUrl,
  });
  let parsed = {};
  try {
    parsed = JSON.parse(rls.stdout);
  } catch {
    parsed = { raw: rls.stdout, stderr: rls.stderr };
  }
  report.checks.rlsCrossTenant = {
    verdict: rls.code === 0 ? "PASS" : "FAIL",
    ...parsed,
  };
} else {
  report.checks.migration = {
    verdict: "NOT_RUN",
    reason: "Set DATABASE_URL or TEST_DATABASE_URL (Neon connection string)",
  };
  report.checks.rlsCrossTenant = { verdict: "NOT_RUN", reason: "No database URL" };
}

const clerk = run("node", ["scripts/verify-clerk-restricted.mjs"]);
let clerkJson = {};
try {
  clerkJson = JSON.parse(clerk.stdout);
} catch {
  clerkJson = { raw: clerk.stdout, stderr: clerk.stderr };
}
report.checks.clerkRestricted = {
  exitCode: clerk.code,
  ...clerkJson,
};

const audit = run("npm", ["audit", "--omit=dev", "--json"]);
let auditProd = {};
try {
  auditProd = JSON.parse(audit.stdout).metadata?.vulnerabilities ?? {};
} catch {
  auditProd = { error: "parse failed" };
}
const auditAll = run("npm", ["audit", "--json"]);
let auditMeta = {};
try {
  auditMeta = JSON.parse(auditAll.stdout).metadata?.vulnerabilities ?? {};
} catch {
  auditMeta = {};
}

report.checks.npmAudit = {
  production: auditProd,
  allDependencies: auditMeta,
  recommendation:
    "Upgrade vitest to >=4.1.12 (dev) and next when ready for major bump; zod 4.x when validating schemas",
};

const blocking = [];
if (report.checks.migration.verdict === "FAIL") blocking.push("migration");
if (report.checks.rlsCrossTenant.verdict === "FAIL") blocking.push("rls");
if (clerkJson.pass === false && clerkJson.status === "FAIL") blocking.push("clerk");

report.overallVerdict =
  report.checks.migration.verdict === "PASS" &&
  report.checks.rlsCrossTenant.verdict === "PASS" &&
  clerkJson.pass === true
    ? "WAVE_1_FULL_PASS"
    : report.checks.migration.verdict === "PASS" &&
        report.checks.rlsCrossTenant.verdict === "PASS" &&
        clerkJson.status === "NOT_VERIFIED"
      ? "WAVE_1_CONDITIONAL_PASS"
      : report.checks.migration.verdict === "NOT_RUN" ||
          report.checks.rlsCrossTenant.verdict === "NOT_RUN"
        ? "WAVE_1_PARTIAL"
        : "WAVE_1_FAIL";

report.blocking = blocking;

const outPath = path.join(
  process.cwd(),
  "..",
  "WAVE_1_VERIFICATION_REPORT.snl",
);
const snl = `# FILE: WAVE_1_VERIFICATION_REPORT.snl
ARTIFACT_TYPE=WAVE_VERIFICATION_REPORT
WAVE=1
GENERATED_ON=${report.executedOn}
OVERALL_VERDICT=${report.overallVerdict}
REPORT_JSON=${JSON.stringify(report).replace(/\n/g, " ")}
`;

fs.writeFileSync(outPath, snl);
console.log(JSON.stringify(report, null, 2));
process.exit(
  report.overallVerdict === "WAVE_1_FULL_PASS"
    ? 0
    : report.overallVerdict === "WAVE_1_CONDITIONAL_PASS"
      ? 0
      : report.overallVerdict === "WAVE_1_PARTIAL"
        ? 3
        : 1,
);
