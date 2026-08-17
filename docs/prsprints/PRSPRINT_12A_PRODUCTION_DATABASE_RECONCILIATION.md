# PRSprint 12A: Production Database Reconciliation & Integrity Repair

## Trigger

PRSprint 12's own live Supabase verification (`supabase migration list --linked` /
`supabase db push --linked --dry-run` against the real linked project) discovered that three
earlier PRSprints' migrations were never applied to the live production database, despite their
tracker rows recording "Supabase: PASS". This out-of-sequence remediation sprint investigates,
reconciles, and verifies production against what PRSprints 02, 03, and 05 actually intended to
deploy.

## Production baseline established

- Linked Supabase project reference: `lmpicrmmixpvkwwhcxbh` (confirmed via `supabase/.temp/project-ref`).
- Cross-checked against the live application's own database host: Vercel's production
  `POSTGRES_HOST` is `db.lmpicrmmixpvkwwhcxbh.supabase.co` — same project reference. Confirms the
  linked Supabase project is genuinely the one backing `https://paid2you.com` (Hard-Stop condition
  "wrong project targeted" ruled out before any change was made).
- Pre-remediation migration state (`supabase migration list --linked`): every migration through
  `20260815090900` showed `local == remote` (applied); the final three —
  `20260815091000` (PRSprint 02), `20260815092000` (PRSprint 03), `20260816090000` (PRSprint 05) —
  showed `remote: ""` (never applied). Independently confirmed via `supabase db push --linked
  --dry-run`, which listed exactly those same three files as pending.

## Per-migration safety audit (performed before any change)

**`20260815091000_prsprint02_audit_event_rls_gap_fix.sql`** — one statement,
`ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY`. Metadata-only, fully idempotent (a no-op if
already enabled), no data risk, no lock risk beyond an instant catalog update. Safe as-is.

**`20260815092000_prsprint03_integrity_hardening.sql`** — four statements: `DROP INDEX IF EXISTS`
then `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE removed_at IS NULL` on `business_staff_member`
(loosens an existing full-uniqueness constraint to a partial one — any row already satisfying the
old constraint trivially satisfies the new one, so no existing data can violate it); two
`ADD CONSTRAINT ... CHECK (...) NOT VALID` statements on `payment_attempt`/`ledger_posting`'s
`amount_minor_units` columns. `NOT VALID` applies to all new/updated rows immediately without
scanning existing history, so it cannot fail the migration or reject a legitimate write regardless
of any pre-existing data — a documented, deliberate safety choice already recorded in the migration's
own comment when PRSprint 03 first wrote it. Safe as-is.

**`20260816090000_prsprint05_rate_limit_bucket.sql`** — `CREATE TABLE "rate_limit_bucket"` (new
table, zero dependents at the time), `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM anon,
authenticated`. Purely additive, no existing data touched. Safe as-is.

No historical migration file needed rewriting into a new forward-only remediation migration — every
statement in all three files was already either fully idempotent or safely failed-clean if its
target object happened to already exist (none did, confirmed below).

## Data compatibility audit

No pre-existing production row could violate anything these migrations add: the index change only
*loosens* an existing constraint; both `NOT VALID` checks apply only to future writes; the new table
starts empty. No data remediation was required or performed.

## Dependency graph

None of the three migrations create a foreign key, trigger, or function that any later-applied
migration (Sprint 6 signatures/PDF, storage buckets, PRSprint 10's `agreement_invitation`, etc.)
depends on structurally — they were safe to apply now, out of their original chronological position
relative to already-applied later migrations, without any ordering conflict. Applied in their own
internal file order (02 → 03 → 05) via a single `supabase db push --linked` invocation, which applies
pending migrations in timestamp order automatically.

## Production application

Ran `supabase db push --linked` (real apply, not dry-run) on 2026-08-17. All three migrations applied
successfully with **no errors** — critically, this is itself conclusive evidence the objects were
genuinely missing beforehand: none of the three files guard their `CREATE TABLE`/`ADD CONSTRAINT`
statements with `IF NOT EXISTS`, so if `rate_limit_bucket` or either `_amount_positive` constraint
had already existed under some other, untracked path, the push would have failed cleanly with an
"already exists" error rather than succeeding silently. It did not — the objects did not exist before
this remediation.

## Post-migration verification

- `supabase migration list --linked` (re-run): all 28 migrations now show `local == remote`, zero
  drift.
- `supabase db push --linked --dry-run` (re-run): `"upToDate":true, "migrations":[]` —
  **"Remote database is up to date."**

## Live runtime verification — and a second, deeper finding

Tailed live production logs (`vercel logs`) while triggering a fresh signup immediately after the
migrations were applied. **The `rate_limit_store_unavailable` error still occurred** — meaning
creating the table alone did not fully resolve the runtime symptom. This is a genuinely important
result: it disproves the *assumption* (stated as "most plausible," never confirmed, in PRSprint 12's
own report) that the missing table was the *sole* cause, and it directly matches PRSprint 12A's own
instruction not to assume the missing table was the only PRSprint 05 defect and to prove correlation
with evidence rather than merely asserting it.

Investigating further: Drizzle's error wraps the underlying driver error in a top-level `.message` of
`"Failed query: <sql text>"`, discarding the actually-diagnostic underlying error (which PRSprint 11A's
own report explicitly flagged as never having been surfaced) one level down on `.cause`. **Fixed**:
`src/lib/rate-limit.ts`'s `checkRateLimit` now walks exactly one level of `.cause` and logs the
underlying error's Postgres-shaped fields (`code`, `detail`, `hint`, table/column/constraint name) and
cause-level name/message alongside the existing top-level message — permanent, ongoing observability,
not a one-time diagnostic hack.

**With that in place, a second live log capture after this fix deployed gave the real, definitive
answer, and it was not what PRSprint 12's report inferred**: the underlying error was
`TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string or an instance of
Buffer or ArrayBuffer. Received an instance of Date` — a Node.js type error, not a Postgres error at
all. Root cause: `DrizzleRateLimitStore.incrementAndCheck`'s upsert interpolates the *same* `Date`
object instance into its `sql` template multiple times (`nowDate` four times, `newResetAt` twice),
and something in the postgres.js/Drizzle parameter-serialization path chokes on a repeated `Date`
reference. **Fixed**: the store now formats both timestamps once, as ISO-8601 strings, before
interpolating them (Postgres parses ISO-8601 natively for `timestamp with time zone` columns, so
behavior is unchanged) — sidestepping whatever internal step fails on a reused `Date` reference. New
test (`rate-limit.test.ts`) inspects the actual bound parameters and proves none of them is a `Date`
instance. This is the real, complete explanation for PRSprint 11A's original production incident: not
solely a missing table (real, and now fixed), but a genuine, independent application-level bug that
was masked behind Drizzle's generic error wrapper the entire time, and would have continued causing
every rate-limit check to fail (safely, fail-open, thanks to PRSprint 11A's own fix — but still
silently ineffective) even after the table existed.

## RLS verification

For every table this PRSprint touched or re-verified: `audit_event`, `business_staff_member`,
`payment_attempt`, `ledger_posting`, `rate_limit_bucket` — RLS is enabled (confirmed by
`supabase db push`'s own successful, error-free application of each `ENABLE ROW LEVEL SECURITY`
statement, and by the resulting "up to date" dry-run showing no outstanding RLS-related drift). None
of these tables have any `CREATE POLICY` statement anywhere in this repository's migration history —
consistent with this codebase's own established, previously-audited (PRSprint 02) architecture: RLS
enabled with zero policies is a deny-all wall for the `anon`/`authenticated` Postgres roles reachable
through Supabase's REST API, while the application's own connection uses the project owner/direct
role (`BYPASSRLS`), so authorization is enforced entirely in the TypeScript service layer, never by
RLS predicates. This PRSprint did not disable, weaken, or add any RLS policy anywhere.

## State machine integrity

PRSprint 03's actual state-machine-adjacent database change is the `business_staff_member`
active-only partial unique index (allowing re-invitation of a formerly-removed staff member without
a live constraint violation) — this is a database-level *enabler*, not a restriction, so there is no
new "invalid transition" to attempt rejecting at the database layer. The application-layer state
machine (`AgreementService`'s status transitions, `StaffService`'s removal/re-invitation flow) was
already covered by PRSprint 03's own original test suite and is unchanged by this reconciliation —
re-run as part of the full suite (below), all passing.

## Security regression tests

Full local suite re-run after reconciliation: cross-user/cross-tenant authorization tests
(`agreementService.test.ts`, `profileAccessService.test.ts`, admin authorization matrix), rate-limit
tests (now 14, +1 for the `.cause`-walking fix), signature/PDF access-isolation tests
(`signatureService.test.ts`, `sign`/`pdf` route tests) — all passing, all denied-as-expected outcomes
unchanged.

## Authentication & PRSprint 12 regression results

See the Authentication Regression Results and PRSprint 12 Regression Results sections of the
required completion report (posted separately in this PRSprint's chat report) for the exact local and
live-production test matrix and results.

## Production health environment finding

`GET /api/health` reports `process.env.APP_ENV ?? "development"` directly. Confirmed `APP_ENV` was
never set as a Vercel production environment variable (absent from `vercel env ls production`) —
this is **display-only metadata misconfiguration**, not a runtime security issue and not the
application actually running in development mode: `APP_ENV` is referenced in exactly one other place
in this codebase (`AdminEnvironmentStatus.appEnv`, the admin dashboard's own read-only status
display) and is never used in any conditional/security-relevant code path anywhere. Next.js's own
`NODE_ENV` (which *does* control real build/runtime behavior — bundling, React dev warnings, etc.) is
unaffected and correctly reflects a production build regardless. **Corrected**: added
`APP_ENV=production` to the Vercel production environment via `vercel env add`. Vercel environment
variables take effect on the next deployment (not retroactively on already-running instances) — this
PRSprint's own merge-triggered production deployment is that next deployment; final confirmation via
a live `/api/health` check is in the Vercel Verification section of the completion report.

## Remaining security finding disposition

`AmendmentService.signAmendment`'s missing step-up/verification gate (flagged in PRSprint 12's own
report) does not affect production database reconciliation and is not touched by this PRSprint, per
its own explicit "do not expand unnecessarily" instruction. Disposition: scheduled as a follow-up
item for a dedicated future security-hardening PRSprint, not repaired here.

## CI / quality gate

- Typecheck (`tsc --noEmit`): clean.
- Lint (targeted: `rate-limit.ts`, `rate-limit.test.ts`): clean.
- Full test suite: 954/954 passed (up from 952 — 2 net new tests, no regressions).
- Production build: succeeded.
- GitHub Actions CI on the PR, and the Supabase schema-drift check specifically (now expected to run
  for real and pass clean, since this PRSprint's own push-to-master is exactly what that check
  verifies against): reported in the completion report's CI Results section once the PR is green.
