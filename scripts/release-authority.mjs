#!/usr/bin/env node
// BDD_F09_02/03 operator and deploy-orchestrator CLI. Connects with the caller's OWN login (RELEASE_DATABASE_URL, never printed).
//   platform approve|reject <projectId> <releaseRef> "<reason>"   (member of nasi_platform_release_approver) -> ACT_05B
//   credential <projectId> <releaseRef>                            (member of nasi_deploy_orchestrator)      -> token or denial
//   redeem <token>                                                 (deploy step, orchestrator)              -> AUTHORIZED or denial
// No GitHub/hosting call is made here: a deploy pipeline must redeem the credential before deploying.
import pg from "pg";
import { pathToFileURL } from "node:url";

export async function releaseAuthority(connectionString, [cmd, ...args]) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    if (cmd === "platform") {
      const [decision, project, release, reason] = args;
      if (!["approve", "reject"].includes(decision)) throw new Error("USAGE: platform approve|reject ...");
      const r = await c.query("SELECT record_platform_production_authorization($1, $2, $3, $4) AS id",
        [project, release, decision === "approve" ? "approved" : "rejected", reason]);
      return { act_05b: r.rows[0].id, decision: decision === "approve" ? "approved" : "rejected" };
    }
    if (cmd === "credential") return (await c.query("SELECT issue_production_deploy_credential($1, $2) AS j", args.slice(0, 2))).rows[0].j;
    if (cmd === "redeem") return (await c.query("SELECT redeem_production_deploy_credential($1) AS j", [args[0]])).rows[0].j;
    throw new Error("USAGE: platform|credential|redeem");
  } finally {
    await c.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.RELEASE_DATABASE_URL;
  if (!url) { console.error("RELEASE_DATABASE_URL is BLANK"); process.exit(2); }
  releaseAuthority(url, process.argv.slice(2))
    .then(out => { console.log(JSON.stringify(out)); process.exit(out && out.denied ? 3 : 0); })
    .catch(e => { console.error(e.code === "P0001" || !e.code ? e.message : e.code); process.exit(1); });
}
