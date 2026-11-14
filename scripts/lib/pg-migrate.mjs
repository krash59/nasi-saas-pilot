import fs from "fs";
import path from "path";
import pg from "pg";

/** Split SQL file into executable chunks (handles plpgsql $$ blocks). */
export function splitSqlStatements(sql) {
  const statements = [];
  let buf = "";
  let inDollar = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "$" && sql[i + 1] === "$") {
      inDollar = !inDollar;
      buf += "$$";
      i++;
      continue;
    }
    if (!inDollar && ch === ";") {
      const trimmed = buf.trim();
      if (trimmed && !trimmed.startsWith("--")) statements.push(trimmed);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail && !tail.startsWith("--")) statements.push(tail);
  return statements;
}

export async function runMigrationFile(client, relativePathFromSaasApp) {
  const root = path.join(process.cwd());
  const body = fs.readFileSync(path.join(root, relativePathFromSaasApp), "utf8");
  // Single query: required for plpgsql $$ blocks (splitter-safe).
  await client.query(body);
}

export async function withPg(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
