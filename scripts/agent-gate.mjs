#!/usr/bin/env node
// BDD_F08_02 / BDD_F15_01 CLI for the agent runner, deploy orchestrator and halt reviewer.
// Connects with the caller's OWN login (AGENT_GATE_DATABASE_URL, never printed). All rules live in the DB (migration 014).
//   preflight <projectId> <consentId> <action> [--target <projectId>] [--input-file <path>]   (nasi_agent_runtime)
//   minutes <projectId> <consentId> <minutes>                                                 (nasi_agent_runtime)
//   package <projectId> <consentId> <releaseRef> <checks.json>                                (nasi_agent_runtime)
//   staging <projectId> <releaseRef>                                                          (nasi_deploy_orchestrator)
//   clear <haltId> "<reason>"                                                                 (nasi_agent_halt_reviewer)
// Exit 0 = proceed/ok, 3 = halted or denied, 1 = error.
import pg from "pg";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const one = async (c, sql, params) => (await c.query(sql, params)).rows[0].j;

export async function agentGate(connectionString, [cmd, ...args]) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    if (cmd === "preflight") {
      const [project, consent, action, ...rest] = args;
      const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
      const input = opt("--input-file") ? readFileSync(opt("--input-file"), "utf8") : opt("--input");
      return await one(c, "SELECT agent_preflight($1, $2, $3, $4, $5) AS j", [project, consent || null, action, opt("--target"), input]);
    }
    if (cmd === "minutes") return await one(c, "SELECT agent_record_minutes($1, $2, $3) AS j", [args[0], args[1] || null, args[2]]);
    if (cmd === "package") {
      const [project, consent, release, file] = args;
      const checks = typeof file === "string" && file.trim().startsWith("[") ? file : readFileSync(file, "utf8");
      return await one(c, "SELECT submit_verification_package($1, $2, $3, $4::jsonb) AS j", [project, consent || null, release, checks]);
    }
    if (cmd === "staging") return await one(c, "SELECT promote_to_staging($1, $2) AS j", args.slice(0, 2));
    if (cmd === "clear") return await one(c, "SELECT clear_agent_halt($1, $2) AS j", args.slice(0, 2));
    throw new Error("USAGE: preflight|minutes|package|staging|clear");
  } finally {
    await c.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.AGENT_GATE_DATABASE_URL;
  if (!url) { console.error("AGENT_GATE_DATABASE_URL is BLANK"); process.exit(2); }
  agentGate(url, process.argv.slice(2))
    .then(out => { console.log(JSON.stringify(out)); process.exit(out && (out.halt || out.denied) ? 3 : 0); })
    .catch(e => { console.error(e.code === "P0001" || !e.code ? e.message : e.code); process.exit(1); });
}
