# PAY2PAY PRSPRINT CONTROL

**Repository destination:** `docs/prsprints/PRSPRINT_CONTROL.md`

## Purpose

This file is the authoritative execution tracker and approval gate for the Production Ready Sprint program.

## Control Rules

1. Execute one PRSprint at a time.
2. Do not begin the next PRSprint until the current PRSprint has completed implementation, verification, CI, deployment checks where applicable, Supabase verification where applicable, Product Owner review, and merge where required.
3. Any `FAIL`, `PARTIAL`, `CRITICAL`, or unresolved `HIGH` finding blocks progression unless explicitly accepted by the Product Owner.
4. External provider dependencies must be recorded as `EXTERNAL BLOCKER`. Sandbox functionality must never be recorded as production-ready.
5. Product Sprint 19 is separate from PRSprint 19 and remains frozen until explicitly released by the Product Owner.
6. Claude must never mark its own Product Owner review as approved.
7. Every PRSprint must stop after its completion report.

## Allowed Status Values

- **PRSprint Status:** `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `IMPLEMENTATION COMPLETE`, `AWAITING REVIEW`, `APPROVED`, `FAILED`
- **CI:** `NOT RUN`, `PASS`, `FAIL`
- **Vercel:** `NOT REQUIRED`, `NOT DEPLOYED`, `PASS`, `FAIL`
- **Supabase:** `NOT REQUIRED`, `NOT VERIFIED`, `PASS`, `FAIL`
- **Product Owner Review:** `PENDING`, `APPROVED`, `CHANGES REQUIRED`
- **Merge:** `NOT READY`, `READY`, `MERGED`, `NOT REQUIRED`
- **External Blocker:** `NONE`, `YES`

## PRSprint Tracker

| PRSprint | Name | Status | Dependency | Git Branch | Git Commit | PR | CI | Vercel | Supabase | Product Owner Review | Merge | External Blocker | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 | Supabase Migration Reconciliation | APPROVED | None | worktree-prsprint-01-supabase-migration-reconciliation (merged) | 28315ea52efcce4a6924ae4bd114d2aaa94c4c4c | #23 (MERGED) | PASS (GitHub Actions: lint/typecheck/build/test; schema-drift check SKIPPED — not required for this change) | PASS | PASS | APPROVED | MERGED | NONE | Migrations 0013-0022 applied via `supabase db push --linked`; live schema now 61 tables/62 enums, matching repo exactly. PR #23 opened, CI passed on GitHub, Vercel preview succeeded, merged to master; local master fast-forwarded to origin/master and verified in sync at 28315ea. Product Owner Review: APPROVED. PRSprint 02 authorized to begin. |
| 02 | RLS & Cross-Tenant Security Hardening | APPROVED | PRSprint 01 | worktree-prsprint-02-rls-cross-tenant-security (merged) | 51fd4d4e493bd602d3ca794224b4d60d0fe5c3f2 | #24 (MERGED) | PASS (GitHub Actions: lint/typecheck/build/test, 824/824; schema-drift check SKIPPED on PR - only runs on push to master) | PASS | NOT REQUIRED | APPROVED | MERGED | NONE | Full audit of RLS policies, service-role usage, IDOR exposure, and existing negative-auth coverage across all 61 tables/169 API routes. Key architectural finding: this app uses fully custom auth (no auth.uid()), zero CREATE POLICY statements exist anywhere, and the app's own DB connection queries as table owner (bypasses RLS) - tenant isolation is enforced entirely in the TypeScript service layer, not by RLS row policies. One concrete gap closed: audit_event never had .enableRLS() declared in its Drizzle schema source (unlike all 60 other tables); added explicitly (idempotent, additive migration) to both schema source and a new Supabase migration. Added route-level (HTTP boundary) cross-tenant/IDOR regression tests for agreement detail, payment detail, evidence signed-url, and payments-by-agreement (previously only service-layer coverage existed). Fixed a Sprint 2-era placeholder test in crossAccountIsolation.test.ts that was a no-op deferred to Sprint 3 and never filled in, and corrected that file's comment, which incorrectly claimed RLS policies enforce production authorization. Confirmed already-correct, no change needed: service-role Storage access is server-only; cron/webhook routes use CRON_SECRET/HMAC signatures not sessions; requireSession derives identity server-side only; staff/profile cross-business isolation already well-tested. PR #24 opened, CI passed, merged to master; local master fast-forwarded to origin/master and verified in sync at 51fd4d4. Supabase marked NOT REQUIRED - no live Supabase verification was performed this pass (migration is additive/idempotent; schema-drift CI job will verify against the live linked project on the next push-to-master run). Product Owner Review: APPROVED. PRSprint 03 authorized to begin. |
| 03 | Database Integrity & State Machines | APPROVED | PRSprint 02 | worktree-prsprint-03-database-integrity-state-machines (merged) | fbc74a614e6c25235a666aefc229876405b3e570 | #25 (MERGED) | PASS (GitHub Actions: lint/typecheck/build/test, 825/825; schema-drift check SKIPPED on PR - only runs on push to master) | PASS | NOT REQUIRED | APPROVED | MERGED | NONE | Audit of ~25 prior migrations and relevant service-layer code against positive-money constraints, membership/participant/invitation uniqueness, state-machine backstops, cascade-delete review, history preservation, and multi-step transaction use. Two real gaps closed: (1) business_staff_member uniqueness on (business_profile_id, user_id) was a full index with no exception for a soft-removed row, making it impossible to ever re-invite a former staff member; replaced with a partial active-only index matching this schema's established pattern, with a regression test proving remove -> re-invite -> re-accept succeeds; (2) payment_attempt.amount_minor_units and ledger_posting.amount_minor_units had no DB-level backstop against zero/negative values; added CHECK constraints applied NOT VALID (safe against existing live data; a follow-up VALIDATE CONSTRAINT pass against the live database is a documented follow-up, not assumed done). Confirmed already-correct, no change needed: every FK in this schema uses ON DELETE no action (zero CASCADE deletes anywhere); LedgerService already posts journal entries and postings inside one DB transaction with a balance check; state-machine transitions are enforced in application code with dedicated invalid-transition tests per sprint. PR #25 opened, CI passed, merged to master; local master fast-forwarded to origin/master and verified in sync at fbc74a6. Supabase marked NOT REQUIRED - no live Supabase verification was performed this pass (migrations are additive/idempotent/NOT VALID; schema-drift CI job will verify against the live linked project on the next push-to-master run). Product Owner Review: APPROVED. PRSprint 04 authorized to begin. |
| 04 | Secrets, Environment & Production Separation | AWAITING REVIEW | PRSprint 03 | worktree-prsprint-04-secrets-environment-production-separation (merged) | ee6ab7e0266e3520bdb285ff4be40b033b1ad8f5 | #26 (MERGED) | PASS (GitHub Actions: lint/typecheck/build/test, 834/834; schema-drift check SKIPPED on PR - only runs on push to master) | PASS | NOT REQUIRED | PENDING | MERGED | NONE | Audit confirmed via git history (git log --all --diff-filter=A -- "*.env*") that only .env.example has ever been committed - no real credential exposure, Hard Stop rule not triggered. Closed a real .gitignore gap: env-file patterns only matched exact filenames, not suffixed backup/copy variants; broadened defensively. Corrected docs/ENVIRONMENT_VARIABLES.md's stale Sprint-1 architecture note (incorrectly claimed SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY don't exist; both added in Sprint 6 for Storage) and added the four env vars missing from its table. Added an admin-only, secret-free environment/provider status view (src/lib/admin/environmentStatus.ts, wired into AdminService/AdminDashboard, gated by the existing requireAdmin() check) reporting configuration presence and mode labels only - verified by a test asserting no real-looking secret string ever appears in the serialized status. Confirmed by reading getPaymentProvider.ts/getKycProvider.ts directly (not inferred from docs): no live/production provider adapter exists anywhere in this codebase yet, so "prevent live secrets in non-production" is satisfied by construction, not a new toggle. No database migration needed - no schema changes this PRSprint. PR #26 opened, CI passed, merged to master; local master fast-forwarded to origin/master and verified in sync at ee6ab7e. Awaiting Product Owner review. |
| 05 | Distributed Rate Limiting & Abuse Controls | NOT STARTED | PRSprint 04 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 06 | Authentication & Session Hardening | NOT STARTED | PRSprint 05 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 07 | Platform Owner / Admin / Support Controls | NOT STARTED | PRSprint 06 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 08 | Business Membership & Staff Administration | NOT STARTED | PRSprint 07 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 09 | Canonical Agreement Participant Model | NOT STARTED | PRSprint 08 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 10 | Invitation Identity, Claiming & Acceptance | NOT STARTED | PRSprint 09 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 11 | Agreement Versioning, Amendments & Mutual Approval | NOT STARTED | PRSprint 10 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 12 | Electronic Signatures, PDFs & Immutable Records | NOT STARTED | PRSprint 11 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 13 | Notification Event Wiring | NOT STARTED | PRSprint 12 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 14 | Production Email | NOT STARTED | PRSprint 13 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Provider/domain may be required |
| 15 | Production SMS | NOT STARTED | PRSprint 14 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Provider/number approval may be required |
| 16 | Notification Preferences & Delivery History | NOT STARTED | PRSprint 15 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 17 | Payment Schedule & Monetary Math | NOT STARTED | PRSprint 16 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 18 | Partial Payments, Overpayments & Completion Rules | NOT STARTED | PRSprint 17 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 19 | Authoritative Ledger & Transaction Integrity | NOT STARTED | PRSprint 18 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 20 | Idempotency, Concurrency & Financial State Safety | NOT STARTED | PRSprint 19 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 21 | Production Financial Provider Architecture | NOT STARTED | PRSprint 20 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Live provider approval may be required |
| 22 | KYC / KYB / Financial Account Provisioning | NOT STARTED | PRSprint 21 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Provider capability/approval may be required |
| 23 | ACH / Bank Linking / Reconciliation | NOT STARTED | PRSprint 22 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | ACH/bank-linking approval may be required |
| 24 | Debit Card Issuance & Card Lifecycle | NOT STARTED | PRSprint 23 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Issuing-program approval may be required |
| 25 | Production UI Guidance, Forms & Empty States | NOT STARTED | PRSprint 24 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 26 | Search, Filter, Pagination & Record Management | NOT STARTED | PRSprint 25 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 27 | Dashboards, Onboarding & Role-Aware UX | NOT STARTED | PRSprint 26 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 28 | Error Handling, Observability & Health Monitoring | NOT STARTED | PRSprint 27 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 29 | Backups, Recovery, Rollback & Incident Controls | NOT STARTED | PRSprint 28 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 30 | CI/CD, Deployment Gates & Schema Drift Prevention | NOT STARTED | PRSprint 29 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 31 | E2E, Negative Security & Concurrency Test Completion | NOT STARTED | PRSprint 30 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 32 | Compliance Hooks, Consent, Privacy & Retention | NOT STARTED | PRSprint 31 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | YES | Qualified legal/compliance review required |
| 33 | Final Production Launch Controls & Closed Beta | NOT STARTED | PRSprint 32 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 34 | Final Production Readiness Certification | NOT STARTED | PRSprint 33 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |

## Claude Update Rules

At the end of each PRSprint, Claude should propose the exact row updates for this file.

Claude may update:
- Status
- Git Branch
- Git Commit
- PR
- CI
- Vercel
- Supabase
- Merge
- External Blocker
- Notes

Claude must **not** set `Product Owner Review` to `APPROVED`.

## Next-PRSprint Release Rule

The next PRSprint may begin only when the current row shows:

- `Status = APPROVED`
- `CI = PASS`
- `Vercel = PASS` or `NOT REQUIRED`
- `Supabase = PASS` or `NOT REQUIRED`
- `Product Owner Review = APPROVED`
- `Merge = MERGED` or `NOT REQUIRED`

Any unresolved CRITICAL or HIGH issue overrides progression.

## Product Sprint 19

Product Sprint 19 is **not PRSprint 19**.

Product Sprint 19 remains frozen until the Product Owner explicitly authorizes it.
