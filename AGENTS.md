# AGENTS.md — NASI v1 / saas_app

## Evidence
- Every factual claim cites a file:line or output run this session. Otherwise label it INFERRED.
- Report each verification result with the command (redacted if necessary), exit code, source identity, and UTC date/time. For commands not run, record NOT-RUN and exit code N/A.
- Source identity includes the commit plus a diff hash when applicable, or hashes of relevant files, including untracked inputs. A commit hash alone is insufficient for a dirty working tree.
- Evidence predating the last relevant change to code, configuration, schema, dependencies, or test inputs is STALE. Unrelated changes do not invalidate evidence.
- Skipped tests are NOT-RUN, never PASS. State which layers a mock hides. Do not substitute a stub and call it proof.
- Allowed verification statuses: VERIFIED-E2E, UNIT-ONLY, FAIL, NOT-RUN, STALE, NOT-DEMONSTRATED, BLOCKED.
- VERIFIED-E2E names the tested workflow, environment, and acceptance criteria; it does not imply untested workflows are verified.
- Mark Done only with an acceptance verdict, source identity, and verification date/time after the last relevant source change. A successful command exit alone does not establish acceptance.

## Safety
- Before running or recommending execution of a script, read it and inspect its invoked scripts and SQL. List destructive operations (including DROP, TRUNCATE, DELETE, file removal, and role or privilege changes) and external side effects. If the execution chain cannot be inspected, report the limitation and do not run destructive operations.
- Schema-dropping suites run only against the disposable database nasi_audit at 127.0.0.1, never the app database. Verify the effective connection target and that the database is disposable before execution; fail closed on a mismatch or uncertainty.
- Treat db:migrate as non-idempotent until its implementation and migration tracking have been inspected. Never rerun blindly; without evidence that reruns are safe, run only once per fresh database.
- Never print environment values, connection URLs, keys, or other secrets. Report environment variable presence as SET or BLANK. Redact sensitive fields in commands and errors before reporting them.

## Scope
- Read-only unless told otherwise. No new product requirements. Production and real-customer data are unauthorized.
- This file does not grant execution or release authority or replace applicable NWS controls. Follow the user's explicit authorized scope and applicable governing instructions.
- If a prerequisite is missing (for example a database or key), mark the dependent work BLOCKED and report the exact error with sensitive fields redacted. Continue independent authorized inspection and tests; do not substitute a stub and call it proof.

## Required Done-card gate
- Before marking a NASI audit card Done, use audit/tools/cards.py move(); never bypass it by editing a Done status directly. The move operation verifies the candidate card's complete evidence set against its verification record and current app source before writing.
- Before reporting NASI/saas_app build acceptance or claiming the audit's Done cards are verified, run this read-only command from any directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 /home/dawud/systems/docs/gp1p/nasi_v1/audit/tools/check_done.py --register /home/dawud/systems/docs/gp1p/nasi_v1/audit/register.json --source-root /home/dawud/systems/docs/gp1p/nws_gas_saas_implementation_v1/saas_app --json
```

- Run after the final relevant source or verification-record change. Exit 0 permits only a claim of record consistency; actual acceptance still requires the relevant tests. Exit 1 means NOT-DEMONSTRATED/STALE or another reported violation; exit 2 means the gate could not evaluate valid inputs. Do not claim acceptance on either nonzero result.
- Use the record contract in /home/dawud/systems/docs/gp1p/nasi_v1/audit/tools/CHECK_DONE.md. Create records only from actual verification, never to silence a failed gate. Keep command output and source identity with the verification evidence, with secrets redacted.
- A gate failure blocks Done/acceptance claims, not independent authorized development or tests. The full audit gate checks every Done card; the move gate checks the candidate card and requires its dependencies to have Done status. Neither grants execution or release authority.
