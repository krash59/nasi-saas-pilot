# Runbook: staging rollback (S13_01)

Scope: hosted staging only (Vercel project `nasi-saas-pilot-staging`, synthetic data). Production is not authorized.
Who runs it: the agent (Claude Code) from the owner's laptop, where the Vercel CLI (pinned 65.2.0) is signed in.
Pilot recovery-time objective (RTO): 60 seconds from the start of the rollback to `/api/health` returning 200.

## When
A staging deploy is unhealthy: the `deploy` workflow reports `STAGING_UNHEALTHY` or `VERCEL_DEPLOYMENT_FAILED`,
or `https://nasi-saas-pilot-staging.vercel.app/api/health` does not return 200.

## Steps (agent)
1. Find the last good deployment: `npx vercel@65.2.0 ls nasi-saas-pilot-staging --scope dl-ce9d` (newest Ready before the bad one).
2. Roll back: `npx vercel@65.2.0 rollback <good deployment URL> --scope dl-ce9d --yes`.
3. Check: `/api/health` returns 200; record the timing.
4. Fix forward on a branch, pull request, CI green, merge to `main`.
5. After a rollback Vercel stops moving the staging address to new `main` builds. After the fix merges, run
   `npx vercel@65.2.0 promote <new deployment URL> --scope dl-ce9d --yes`, then confirm
   `npx vercel@65.2.0 inspect nasi-saas-pilot-staging.vercel.app --scope dl-ce9d` shows the new deployment.

## Database
Rollback changes application code only. Migrations are forward-only and are never rolled back with the code; a release
must stay compatible with the schema of the release before it. The drill checked the schema fingerprint and row
statistics before and after: unchanged.

## Fallback (Vercel CLI unavailable)
`git revert <bad merge commit>` on a branch, pull request, CI green, merge; Vercel builds the reverted `main`.
Slower than the RTO (CI plus build is several minutes); use only if step 2 cannot run.

## Drill record
2026-11-17: good A, broken B (health 503), rollback to A, health 200 after 23 s; database unchanged; both synthetic
tenants still isolated afterwards. Evidence: `nasi_v1/audit/evidence/WAVE4/ROLLBACK_DRILL.txt`.
