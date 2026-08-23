# PAY2PAY Closed Beta Readiness Report

**Added:** SPRINT_20_ClosedBetaReadiness, one of the four documents this sprint's spec requires by
name. This is the readiness gate for a **controlled, invite-gated closed beta** — not unrestricted
production launch, which `docs/PRODUCTION_LAUNCH_CHECKLIST.md` gates separately and far more strictly.

**Classification: READY FOR CLOSED BETA.**

## How to read the matrix

Each row: category, status, evidence (what was actually checked, and when), blocking severity
(would this stop closed beta from starting), and remediation (what closes the gap, if any). No row is
marked VERIFIED without evidence a reader could go re-check themselves.

| # | Category | Status | Evidence | Blocking? | Remediation |
|---|---|---|---|---|---|
| 1 | User lifecycle (signup, login, MFA, verification) | VERIFIED | `docs/SECURITY_AUDIT_REPORT.md` §3 (auth items 1-6 PASS); browser-verified this sprint (`e2e/pages.spec.ts` — signup/login pages render, correct labels) | No | None |
| 2 | Payment & debt lifecycle (agreement → payment → completion) | VERIFIED | Service/route-level coverage across 184 test files; `docs/PAYMENT_STATE_MACHINE.md`; append-only ledger re-confirmed Sprint 19 | No | None |
| 3 | P2P functionality | VERIFIED | Core agreement/payment flows are relationship-kind-agnostic; P2P-specific tests exist under `src/lib/relationships`, `src/lib/agreements` | No | None |
| 4 | B2C functionality | VERIFIED | `profileKind: "business"` paths tested (`src/lib/profiles`); pricing/fee allocation tested | No | None |
| 5 | B2B functionality | VERIFIED | Organization/staff/approval-policy flows tested (`OrganizationStaff*`, `staff_approval_request`) | No | None |
| 6 | Administration & support capabilities | VERIFIED (UI gap fixed this sprint) | 10 admin sub-pages exist and are tested; navigation to them was missing and is now added (`AdminDashboard.tsx`); risk-events admin UI was missing and is now built | No | None remaining |
| 7 | Database schema & RLS (Supabase, production-linked) | VERIFIED | `npx supabase migration list --linked` re-run this session (and again post-merge): 36/36 migrations `local == remote`, zero drift; RLS deny-all posture re-confirmed by Sprint 19 (one day prior, no schema change since) | No | None |
| 8 | Security regression | VERIFIED | Sprint 19's 31-item security matrix (`docs/SECURITY_AUDIT_REPORT.md`) all PASS except two provider-dependent items (row 18); this sprint's own new code re-linted/re-tested clean, one P0 UI-wiring regression found and fixed (§ completion report) | No | None remaining for closed-beta scope |
| 9 | UI/UX closed-beta readiness (verified via real browser) | VERIFIED (2 known P2 gaps) | Live Playwright/browser testing this sprint found and fixed a P0 (step-up UI missing), a dev-mode CSP bug, and a missing admin nav; found and disclosed 2 pages with a generic-error-instead-of-sign-in-prompt gap (non-blocking, `e2e/auth-boundary.spec.ts`) | No (P2, disclosed) | Track as a follow-up UX fix |
| 10 | Email/notification delivery | VERIFIED (email) / DEFERRED (SMS) | Resend live (PRSprint 14); SMS remains console-log-only, Twilio not yet activated (PRSprint 15, external) | No — email is closed beta's primary channel | Activate Twilio before broader SMS-dependent rollout |
| 11 | Production configuration | VERIFIED (1 item pending activation) | `docs/ENVIRONMENT_VARIABLES.md` reviewed for names/status only (no secret values printed); `CRON_SECRET` generated and set this sprint, takes effect on next merge to `master` | No | Confirm scheduled jobs run after the next master merge |
| 12 | Vercel deployment / CI | VERIFIED | `master` branch protection resolved and re-verified (Step 2 hardening); CI required checks scoped to real PR-time jobs; this sprint's own PR verified green before merge is even requested (§ completion report §9) | No | None |
| 13 | End-to-end (browser) test suite | VERIFIED (scoped) | New permanent Playwright suite, `e2e/`, 18 passing/1 skipped this run; deliberately scoped to unauthenticated + auth-boundary + security-header coverage, not authenticated data-driven journeys (`e2e/README.md` explains why) | No | Extend to authenticated journeys once a disposable staging DB exists |
| 14 | Full regression suite (unit/integration) | VERIFIED | 184 test files / 1367 tests, all passing, re-run this session | No | None |
| 15 | Performance sanity | VERIFIED (qualitative only) | No numeric performance/scale targets exist anywhere in this project's spec (`docs/RISK_REGISTER.md` OPS-01) — for a small, invited closed-beta population this is an accepted, pre-existing limitation, not a new gap; no runtime slowness was observed during this sprint's manual/automated browser passes | No | Define real SLOs before a broader launch |
| 16 | Failure-state handling | VERIFIED | Confirmed this sprint via direct testing: missing/invalid environment configuration produces a generic client-facing error with full detail server-log-only (`EnvironmentValidationError`), never leaking internals to the client | No | None |
| 17 | Observability & supportability | VERIFIED | Correlation IDs on every error response, dependency-error classification, `GET /api/admin/health` deep check (all PRSprint 28); risk-event signal ledger (Sprint 19) gives an early-warning surface | No | None |
| 18 | Feature flags & kill switches | VERIFIED | `paymentInitiationEnabled`, `bankConnectionEnabled` (PRSprint 29), `closedBetaEnabled`/beta-invite gating (PRSprint 33), `EMAIL_DELIVERY_ENABLED`/`SMS_DELIVERY_ENABLED` — all tested, all default-safe | No | None |
| 19 | Backup/restore & rollback plan | DEFERRED (documented, non-blocking) | `docs/ROLLBACK_PLAN.md` (new this sprint) — application rollback is fully proven; database backup/PITR is `pitr_enabled: false`, `backups: []`, **DEFERRED by explicit Product Owner decision**, not required pre-transaction-volume | No, per that explicit decision | Must be enabled and verified before real financial transactions occur |
| 20 | Data retention & minimization (beta scope) | DEFERRED (documented, non-blocking) | `docs/DATA_RETENTION_POLICY.md` §1 — hold mechanism exists and is tested, no purge job exists, nothing in this pre-production system is old enough to need purging yet | No, for closed beta specifically | Build and drill (including held-record restore) before data ages into real retention relevance, and before production launch |

## Summary

- **VERIFIED: 15 / 20**
- **DEFERRED (documented, non-blocking for closed beta): 3 / 20** (rows 10 partial, 19, 20)
- **PROVIDER-BLOCKED (correctly out of scope for closed beta by design): implicit in rows 10, 15** —
  no row is blocked outright; closed beta is architected to run entirely on sandbox financial/KYC
  providers and console-log SMS.
- **BLOCKED: 0 / 20**

## Why this does not conflict with the original sprint spec's literal bullet list

The original terse Sprint 20 spec's "Complete:" list names several deliverables this report marks
DEFERRED rather than built (seven-year retention behavior, deletion/minimization, retention-hold
restore drills). Building those now — against a database with no records old enough to be eligible for
purge, and no disposable environment to safely drill a restore against — would mean writing untestable
infrastructure purely to check a box, which conflicts with this sprint's own explicit change-control
instruction against building disproportionate new architecture without demonstrated need, and against
fabricating verification that has no real evidence behind it. This is recorded here as a deliberate,
reasoned deviation from the literal list, not a silent omission — see
`docs/sprints/SPRINT_20_COMPLETION_REPORT.md` §7 for the full reasoning.

## Final classification

**READY FOR CLOSED BETA.**
