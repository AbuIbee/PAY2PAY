# PRSprint 01 — Supabase Migration Reconciliation

**Path:** `docs/prsprints/PRSPRINT_01_SUPABASE_MIGRATION_RECONCILIATION.md`  
**Program:** PAY2PAY Production Ready Sprints  
**Execution Mode:** One PRSprint only.

## Goal

Bring live Supabase into exact alignment with the repository.

## Source Production-Readiness Requirements

**Covers:** 1, 188-192, 194, 197

## Mandatory Execution Rules

1. Read this file completely before changing code.
2. Also read `CLAUDE.md`, `docs/SPRINT_CONTROL.md`, `docs/prsprints/PRSPRINT_PROGRAM.md`, Sprint 18C production-readiness requirements, and prior dependent PRSprint reports.
3. Execute **this PRSprint only**. Never auto-start the next PRSprint.
4. Inspect actual code, Supabase, deployment configuration, and provider state; do not infer completion from documentation alone.
5. Do not silently defer, downgrade, or hide findings.
6. All database changes must use controlled migrations.
7. All authorization changes require negative tests.
8. Never expose secrets, credentials, passwords, CVV, PIN, raw banking credentials, or sensitive authentication data.
9. External live-provider dependencies must be marked `EXTERNAL BLOCKER`; sandbox/mock behavior is not production completion.
10. Stop for ChatGPT/Product Owner review at completion.

## Required Implementation Record

Document:
- files changed;
- database/schema/migrations changed;
- RLS/storage policies changed;
- API/server actions changed;
- UI routes/components changed;
- environment variables/providers changed;
- tests added/changed;
- security implications;
- rollback/forward-fix plan;
- unresolved blockers.

## Required Verification

Run all applicable checks:
- lint;
- typecheck;
- targeted unit tests;
- targeted integration tests;
- authorization/RLS negative tests;
- build;
- migration/schema verification;
- manual workflow verification;
- Vercel preview verification when relevant.

A compile/build alone is never sufficient evidence of PASS.

## Completion Report

Return:
1. implementation summary;
2. exact files changed;
3. database/RLS changes;
4. UI/API changes;
5. automated test results;
6. manual verification;
7. deployment/Vercel status;
8. external blockers;
9. known limitations;
10. Git branch/commit/PR status;
11. acceptance-criteria result.

Use one status: `PASS`, `PARTIAL`, `FAIL`, or `EXTERNAL BLOCKER`.

## Detailed Scope

- Audit repo migrations vs connected Supabase
- Apply missing migrations in controlled order
- Verify tables/columns/types/defaults/PK/FK/indexes/constraints/triggers/functions/enums/views/storage/RLS
- Detect manual schema drift and stale/conflicting migrations
- Verify Vercel production targets the intended Supabase project
- Add schema-version/drift deployment check

## Acceptance Criteria

- [ ] Repo and connected Supabase schema are synchronized
- [ ] No unapplied production migrations remain
- [ ] No application references missing schema objects
- [ ] Expected RLS exists in production
- [ ] Schema-drift check is clean

## Hard Stop / Escalation Rule

Stop on any migration failure, destructive data-loss risk, or unresolved schema drift.

## Required Final Response

```text
PRSPRINT 01 COMPLETE
Status: <PASS | PARTIAL | FAIL | EXTERNAL BLOCKER>
Next PRSprint has NOT been started.
Awaiting ChatGPT/Product Owner PRSprint review.
```
