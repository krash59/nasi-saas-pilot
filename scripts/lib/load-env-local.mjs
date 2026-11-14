import fs from "fs";
import path from "path";

/** Load saas_app/.env.local into process.env (does not override existing env). */
export function loadEnvLocal(cwd = process.cwd()) {
  const envLocal = path.join(cwd, ".env.local");
  if (!fs.existsSync(envLocal)) return false;
  for (const line of fs.readFileSync(envLocal, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
  return true;
}
