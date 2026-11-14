# Wave 1 — Identity & tenant foundation

Authorized by `HITL_AUTHORIZATION_IMPLEMENTATION_WAVE_1.snl`.

## Scope (stories)

- S01_01 / S01_02 — Clerk invite-only sign-in (configure **Restricted** mode in Clerk Dashboard)
- S05_01 / S05_02 — `customers` + `projects` with PostgreSQL RLS
- S02_01 — Operator MFA via Clerk (privileged operator accounts in Clerk org)

## Setup

1. Copy env file and fill in values:
   ```bash
   cp .env.example .env.local
   ```
2. **DATABASE_URL** (required for dashboard/projects):
   - **Neon:** paste the pooled connection string from the Neon dashboard.
   - **Local Docker (dev only):**
     ```bash
     docker run -d --name nws-saas-pg -e POSTGRES_PASSWORD=localdev -p 54333:5432 postgres:16-alpine
     ```
     In `.env.local`:
     `DATABASE_URL=postgresql://postgres:localdev@127.0.0.1:54333/postgres`
3. **Clerk:** keys from Clerk dashboard; enable **Restricted** sign-up mode.
4. **OPENAI_API_KEY:** for design chat (Wave 2).

```bash
npm install
npm run db:migrate    # reads .env.local
npm run dev           # http://localhost:3000
```

If migrate prints `Missing DATABASE_URL`, you have not created `.env.local` yet — the dev server can still start, but `/dashboard` will fail until the DB is configured.

## Tests

- `npm test` — app-layer tenant access unit tests (full DB RLS integration tests require Neon in CI — Wave 1 exit criteria).

## Not in Wave 1

GPT design chat, deploy dual auth, metering caps enforcement UI, NWS adapters.

## Governance

- No production deploy / GitHub push unless separately authorized.
- Canonical `nws_gas_v1` unchanged.

## Design Summary → DIR draft

Apply migrations with `npm run db:migrate` before using the workflow. Grant the
runtime database role SELECT, INSERT, UPDATE on `dir_drafts` as for existing
tenant tables; it must not have BYPASSRLS.

Approving a complete Design Summary generates a persistent `AI_DRAFT` containing
the six customer-confirmed fields. The summary page provides a retry button and
a link to review the draft. `POST /api/projects/:projectId/dir` generates or
recovers the same saved draft; GET retrieves it. Generation advances the project
to `dir`, without approving the DIR or authorizing implementation.

`npm test` covers generation and HTTP gates. `npm run verify:dir` additionally
requires `DIR_TEST_DATABASE_URL` pointing to an isolated PostgreSQL database with
migration and role-creation privileges. Its persistence/RLS scenario rolls back
migrations, temporary role, and fixtures. Missing database configuration exits 2,
so omitted integration verification cannot be reported as PASS.

## Customer DIR review and approval

Migration `004_customer_dir_approval.sql` adds explicit approval status, customer
identity, and timestamp to the persisted DIR. On the DIR review page, customers
must confirm review before selecting **Approve DIR**. The authenticated
`POST /api/projects/:projectId/dir/approve` endpoint requires `confirmed: true`
and the `reviewedContent` snapshot; changed or missing drafts fail closed.
Successful approval advances `dir` to `agile_bdd` atomically. Retries preserve
approval evidence. This permits planning only; implementation, deploy, and spend
require their separate authorizations. No subsequent artifacts are generated.

`npm run verify:dir` includes approval HTTP checks and PostgreSQL approval,
retry, stage-transition, and cross-tenant scenarios. Run it in an environment
that permits connecting to the isolated test database before accepting this
workflow as fully verified. `npm test` alone skips that database scenario when
`DIR_TEST_DATABASE_URL` is unset.
