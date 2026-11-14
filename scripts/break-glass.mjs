#!/usr/bin/env node
// BDD_F06_01 operator break-glass CLI (RACI ACT_08). Each operator connects with THEIR OWN database login
// (BREAK_GLASS_DATABASE_URL, never printed). Identity is the login itself, so the two-person rule cannot be
// satisfied by one person typing two names.
//   request <projectId> <minutes 1-60> "<reason>" [--no-notify "<documented exception>"]   (engineer)
//   approve <grantId>                                                                       (owner, different login)
//   read <grantId>                                                                          (requesting engineer only)
//   close <grantId>
import pg from "pg";
import { pathToFileURL } from "node:url";

export async function breakGlass(connectionString, [cmd, ...args]) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    if (cmd === "request") {
      const [project, minutes, reason, flag, exception] = args;
      const notify = flag !== "--no-notify";
      const r = await c.query("SELECT break_glass_request($1, $2, $3, $4, $5) AS id",
        [project, reason, Number(minutes), notify, notify ? null : exception ?? null]);
      return { grant: r.rows[0].id, status: "PENDING_OWNER_APPROVAL" };
    }
    if (cmd === "approve") return { expires_at: (await c.query("SELECT break_glass_approve($1) AS e", [args[0]])).rows[0].e };
    if (cmd === "read") {
      const content = (await c.query("SELECT break_glass_read($1) AS j", [args[0]])).rows[0].j;
      if (content === null) throw Object.assign(new Error("BREAK_GLASS_ACCESS_DENIED"), { code: "BREAK_GLASS_ACCESS_DENIED" });
      return content;
    }
    if (cmd === "close") return { closed: (await c.query("SELECT break_glass_close($1) AS ok", [args[0]])).rows[0].ok };
    throw new Error("USAGE: request|approve|read|close");
  } finally {
    await c.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.BREAK_GLASS_DATABASE_URL;
  if (!url) { console.error("BREAK_GLASS_DATABASE_URL is BLANK"); process.exit(2); }
  breakGlass(url, process.argv.slice(2))
    .then(out => console.log(JSON.stringify(out, null, 2)))
    .catch(e => { console.error(e.code === "P0001" || !e.code ? e.message : e.code); process.exit(1); });
}
