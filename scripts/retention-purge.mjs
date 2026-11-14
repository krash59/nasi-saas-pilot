#!/usr/bin/env node
// BDD_F11_02 scheduled retention purge (DIR §9.2, DATA_RETENTION_POLICY_DRAFT RET_D01..D06).
// Connects as a LOGIN member of nasi_retention_purge (NOBYPASSRLS). Each tenant is purged in its
// own transaction under RLS; the job can only enumerate tenant ids, never read across tenants.
// Usage: DATABASE_PURGE_URL=... node scripts/retention-purge.mjs   (prints counts only, no content)
import pg from "pg";
import { pathToFileURL } from "node:url";

export async function runRetentionPurge(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const summary = { customers: 0, archived_projects: 0, security_events: 0, usage_events: 0, accounts_erased: 0 };
  try {
    const due = (await pool.query("SELECT retention_due_customers() AS id")).rows.map(r => r.id);
    for (const id of due) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_customer_id', $1, true)", [id]);
        const counts = {
          archived_projects: (await c.query("DELETE FROM projects WHERE status = 'archived' AND archived_at + interval '90 days' <= now()")).rowCount,
          security_events: (await c.query("DELETE FROM security_audit_events WHERE created_at + interval '365 days' <= now()")).rowCount,
          usage_events: (await c.query("DELETE FROM usage_meter_events WHERE occurred_at + interval '24 months' <= now()")).rowCount,
        };
        counts.account_erased = (await c.query("SELECT erase_customer_if_window_closed() AS erased")).rows[0].erased === true;
        await c.query("INSERT INTO retention_purge_runs (customer_id, counts) VALUES ($1, $2)", [id, JSON.stringify(counts)]);
        await c.query("COMMIT");
        summary.customers++;
        summary.archived_projects += counts.archived_projects;
        summary.security_events += counts.security_events;
        summary.usage_events += counts.usage_events;
        summary.accounts_erased += counts.account_erased ? 1 : 0;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    }
    return summary;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_PURGE_URL;
  if (!url) { console.error("DATABASE_PURGE_URL is BLANK"); process.exit(2); }
  runRetentionPurge(url)
    .then(s => { console.log(JSON.stringify({ at: new Date().toISOString(), ...s })); })
    .catch(e => { console.error("RETENTION_PURGE_FAILED", e.code ?? e.message?.slice(0, 80)); process.exit(1); });
}
