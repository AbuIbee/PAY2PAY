# PAY2PAY CI/CD, Deployment Gates & Schema Drift Prevention

PRSprint 30 (docs/prsprints/PRSPRINT_30_CI_CD_DEPLOYMENT_GATES_SCHEMA_DRIFT_PREVENTION.md).
Referenced from `docs/OPERATIONS_BACKUP_RECOVERY.md` §2, which previously pointed here before this
file existed.

## 1. CI pipeline (`.github/workflows/ci.yml`)

Runs on every push and pull request to `master`/`main`:

- **`validate`** — lint, `next build` (which also type-checks), `tsc --noEmit`, the full Vitest suite
  (`npm test`), and the tooling-script test suite (`npm run test:tooling`, covering the scripts below).
- **`fresh-migration-test`** (new, PRSprint 30) — applies every file in `supabase/migrations/`, in
  order, to a genuinely empty `postgres:16` service-container database
  (`scripts/apply-migrations-fresh.mjs`). Proves the migration set is internally valid — correct
  syntax, correct ordering, no missing dependency — independent of any linked Supabase project. Needs
  no external credentials, so it runs as a real merge-blocking gate on every push/PR, not just
  post-merge.
- **`schema-drift`** — only on a push to `master`/`main`, and only when `SUPABASE_ACCESS_TOKEN`/
  `SUPABASE_PROJECT_REF` secrets are configured: compares the repo's migration files against the
  linked Supabase project's applied-migrations table (`scripts/check-schema-drift.mjs`). This is the
  environment-mismatch detector master-spec item 189 asks for — a migration that's in the repo but
  never applied (or vice versa) fails this job loudly.
- **`smoke-test`** — manually triggered (`workflow_dispatch`, takes a deployment URL as input), never
  automatic. See §3.

Also always enforced as part of `test:tooling`: **`check-migration-safety.mjs`** — every migration
file is scanned for destructive statements (`DROP TABLE`/`COLUMN`/`TYPE`, `TRUNCATE`, `DELETE FROM`,
`RENAME`, a lossy `ALTER COLUMN ... TYPE`) and must either be free of them or be listed in that
script's `KNOWN_HISTORICAL_EXCEPTIONS` (pre-PRSprint-30 migrations only — never add a new migration to
that list without Product-Owner sign-off; the doc comment on the list says so directly). This is what
makes "every migration to date has been additive" (§2 of the backup/recovery doc) a checked invariant
rather than just a convention.

## 2. IMPORTANT — CI is not currently a hard merge gate

`docs/OPERATIONS_BACKUP_RECOVERY.md` §2 previously stated "Every deploy to `master` is gated by CI...
A bad deploy requires either a CI failure to have been bypassed (it can't be, on the required branch)."
**That was inaccurate and has been corrected there.** PRSprint 30 checked GitHub branch protection on
`master` directly (`gh api repos/AbuIbee/PAY2PAY/branches/master/protection`) and found:

```
{"message":"Branch not protected", ...}
```

No branch protection rule exists. CI runs on every push/PR and its status is visible, but nothing
currently *prevents* a merge or a direct push to `master` when CI is red, or before it has even
finished running.

**This project also has an established, deliberate pattern of direct pushes to `master`** — after each
PRSprint's PR is merged, a separate commit recording "PR merge, CI/Vercel/Supabase results" in
`docs/prsprints/PRSPRINT_CONTROL.md` is pushed directly to `master` (see e.g. commits `93d981a`,
`66c5836`, `bf21ad5` in the repo's own history). A naive branch-protection rule requiring PR review for
every change to `master` would break that established workflow.

**This is flagged as an open decision for the Product Owner, not resolved unilaterally in this
PRSprint** (per CLAUDE.md's "Executive actions with care" guidance — repo branch-protection is a
real, consequential settings change, and per this project's own hard-stop rule 6: "Claude must never
mark its own Product Owner review as approved," the same caution applies to changing what gates that
review). Options for the Product Owner to choose from:

1. Require status checks (at minimum `validate` and `fresh-migration-test`) to pass before merging a
   PR, but still allow repo admins to push directly to `master` (GitHub's "Restrict who can push"
   setting can exempt specific actors) — preserves the tracker-commit workflow while still blocking a
   red-CI PR merge for everyone else.
2. Require status checks unconditionally, and move the tracker-recording commits into the PR itself
   (one more commit on the feature branch before merge) instead of a separate post-merge push —
   changes an established workflow pattern.
3. Leave `master` unprotected for now, accepting that CI is advisory (visible, but not enforced) until
   a decision is made.

Master-spec item 126 ("Production deploys should require explicit approval") is EXTERNAL BLOCKER /
PRODUCT OWNER ACTION REQUIRED for the same reason — it's a repo/GitHub-Environment settings change,
not a code change this PRSprint can make on the Product Owner's behalf.

## 3. Post-deploy smoke tests (master-spec item 129)

`scripts/smoke-test.mjs` runs a small set of read-only, non-destructive checks against a given
deployment URL: liveness (`/api/health`), homepage, login page, and confirms a protected admin route
correctly rejects an unauthenticated caller. Run manually via
`npm run smoke-test -- --url https://your-deployment.example`, or via the `smoke-test`
`workflow_dispatch` CI job.

**Not wired to fire automatically right after a real deploy.** Vercel's own GitHub integration deploys
this project (no custom deploy workflow exists in `.github/workflows/`), and this session has no
Vercel API token to add a deploy-hook-triggered `workflow_dispatch` call. Firing it automatically post-
deploy is a known limitation, not implemented — someone with Vercel project access needs to either add
a deploy hook calling this workflow, or run it manually after each production deploy in the meantime.

Deliberately does **not** attempt a "create/read basic record" check (signing up a real account,
creating an agreement) against a live deployment — master-spec item 94 ("test accounts must be
isolated") has no implementation in this product yet, so running real write traffic against production
here would itself be exactly the "test account contaminating real data" problem that item exists to
prevent. This remains an unresolved known limitation.

## 4. Fresh-database migration test — what it does and doesn't prove

`scripts/apply-migrations-fresh.mjs` stubs the `anon`/`authenticated` Postgres roles and a minimal
`storage.buckets` table — the only two Supabase-managed-service dependencies this repo's migrations
actually reference (confirmed by grep across every migration file; this app has its own independent
session/auth system, `src/lib/auth/authService.ts`, never Supabase Auth, and every table's RLS is
deny-all-by-default with zero `CREATE POLICY` statements). It does **not** run inside a real Supabase
local stack (`supabase start`), so it cannot catch a genuine Supabase-platform-specific incompatibility
beyond those two stubbed surfaces. What it reliably catches: SQL syntax errors, ordering/dependency
bugs between migrations, and naming collisions — exactly the class of bug a "fresh database migration"
test exists to catch per master-spec item 191.
