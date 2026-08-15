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
| 01 | Supabase Migration Reconciliation | AWAITING REVIEW | None | worktree-prsprint-01-supabase-migration-reconciliation | (see completion report) | NOT OPENED | PASS (local: lint/typecheck/build/test) | NOT REQUIRED | PASS | PENDING | NOT READY | NONE | Migrations 0013-0022 applied via `supabase db push --linked`; live schema now 61 tables/62 enums, matching repo exactly. Vercel production-target verification is not possible from this sandbox (no dashboard/API access) — see completion report. |
| 02 | RLS & Cross-Tenant Security Hardening | NOT STARTED | PRSprint 01 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 03 | Database Integrity & State Machines | NOT STARTED | PRSprint 02 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
| 04 | Secrets, Environment & Production Separation | NOT STARTED | PRSprint 03 | — | — | — | NOT RUN | NOT DEPLOYED | NOT VERIFIED | PENDING | NOT READY | NONE |  |
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
