# SPRINT 19 — Fraud Risk & Security Hardening — Completion Report

**Path:** `docs/sprints/SPRINT_19_COMPLETION_REPORT.md`
**Spec:** `docs/sprints/SPRINT_19_FraudRisk_SecurityHardening.md` (original) + the detailed
`SPRINT_19_FraudRisk_SecurityHardening` execution instructions (this session)
**Date:** 2026-08-22
**Branch:** `sprint-19-fraud-risk-security-hardening`

## 1. Executive result

**Status: IMPLEMENTATION COMPLETE — PROVIDER REVALIDATION PENDING.**

All provider-independent security work passes. One P0 and one P1 finding were discovered, fixed, and
regression-tested; no unresolved P0/P1 provider-independent defects remain. Two categories of findings
remain genuinely blocked on live production providers (Twilio, financial/KYC provider) that do not yet
exist in this environment — see §27.

Six parallel pre-flight investigations (auth/account-takeover, registration/invitations,
agreement/payment/ledger/concurrency, bank-connections/webhooks/providers, RLS/admin/audit/fraud-signals,
API/web-hardening/secrets/dependencies) audited the actual implementation before any code change. Most of
this codebase's security posture was already sound, reflecting prior PRSprints' own hardening work
(PRSprint 02 RLS, 05 rate limiting, 06/11A auth, 31 concurrency). This sprint found and closed a small
number of genuine gaps rather than rebuilding what already worked, and built the one capability
(fraud/risk signal model, §12) that was confirmed entirely absent.

## Required security matrix

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Authentication brute-force controls | PASS | Per-IP + per-email rate limiting, re-verified |
| 2 | Password recovery security | PASS | High-entropy tokens, single-use, session revocation on reset |
| 3 | MFA security | PASS | TOTP/SMS, enforced server-side; gap on bank actions fixed this sprint |
| 4 | Session security | PASS | httpOnly/Secure/SameSite, server-side revocation |
| 5 | Account enumeration resistance | PASS | Constant-shape login/reset responses |
| 6 | Signup abuse | PASS | Per-IP velocity limit, closed-beta gating (narrow, documented) |
| 7 | Invitation security | PASS | High-entropy tokens, identity binding, PRSprint-31 race fix re-confirmed |
| 8 | Agreement integrity | PASS | Immutable post-signature (application-enforced), amendment-only change path |
| 9 | Payment manipulation resistance | PASS (P0 fixed) | Server-authoritative amounts; submitPending IDOR closed |
| 10 | Ledger integrity | PASS | Append-only, no update/delete methods exist |
| 11 | Bank connection security | PASS (P1 fixed) | Ownership/disconnect/replace authorization sound; ordering bug + MFA gap fixed |
| 12 | Bank credential non-persistence | PASS | Zero routing/account-number columns anywhere, re-verified |
| 13 | Provider webhook authentication | PASS | Signature verification enforced on all 3 provider types |
| 14 | Provider replay protection | PASS | Atomic (provider, providerEventId) dedup confirmed |
| 15 | Idempotency | PASS | Idempotency-key dedup confirmed across payment/ledger/webhook paths |
| 16 | Concurrency | PASS (2 new fixes) | 11 PRSprint-20 scenarios + 3 new Sprint-19 scenarios all pass |
| 17 | Rate limiting | PASS | ~25 differentiated call sites; fail-open is a documented, protected tradeoff |
| 18 | Transaction limits | PASS (architecture) / PRODUCT OWNER CONFIGURATION REQUIRED (values) | Daily amount/count built this sprint |
| 19 | Risk-event architecture | PASS (built this sprint) | 2 of 6 modeled signal types wired to live call sites |
| 20 | Admin security | PASS | No self-promotion path, step-up required, no weaker financial-action path |
| 21 | Audit integrity | PASS | Good baseline coverage; one P3 gap (reset-requested event) noted |
| 22 | Sensitive-data logging protection | PASS | No secrets/PII in new or spot-checked log calls |
| 23 | API validation | PASS | Zod-before-service pattern confirmed |
| 24 | Injection resistance | PASS | No raw SQL concatenation, no dangerouslySetInnerHTML, no eval |
| 25 | XSS/CSRF/web security | PASS | SameSite=Lax CSRF mitigation; no XSS vectors found |
| 26 | CORS | PASS (N/A) | No explicit config — correct secure default for this app's shape |
| 27 | Security headers | PASS (fixed this sprint) | CSP/HSTS/X-Content-Type-Options/Referrer-Policy/Permissions-Policy added; verified live |
| 28 | Secret management | PASS | No hardcoded credentials; server-only env schema sound |
| 29 | Dependency security | PASS (1 fixed) | nanoid fixed; esbuild (dev-only, moderate) documented, not forced |
| 30 | Kill switches | PASS | Existing payment/bank-connection switches re-verified; audited, safe-default |
| 31 | RLS | PASS | Deny-all pattern intact across all 36 migrations |
| 32 | Tenant isolation | PASS (P0 fixed) | submitPending was the one real gap found |
| 33 | Manual payment abuse protection | PASS | Debtor-only record, recipient-only confirm, overpayment-protected, audited |
| 34 | Provider environment separation | PASS | assertProviderEnvironmentConsistency re-verified sound |
| 35 | Twilio security architecture | PASS (sandbox) / BLOCKED — PRODUCTION PROVIDER REQUIRED (live) | |
| 36 | Financial-provider security architecture | PASS (sandbox) / BLOCKED — PRODUCTION PROVIDER REQUIRED (live) | |
| 37 | Failure/recovery integrity | PASS | Ledger reconciliation/exception detection unchanged, sound |
| 38 | Phase 5 regression | PASS | Full suite includes Phase 5 tests, all passing |
| 39 | Phase 6 regression | PASS | Full suite includes Phase 6 tests, all passing |
| 40 | Phase 6A banking invariants | PASS | Re-verified directly against schema, all 8 invariants hold |
| 41 | Phase 7 regression | PASS | Full suite includes Phase 7 tests, all passing |

## 2. Pre-flight findings

See §3-§9 below for the structured findings. Summary of what pre-flight confirmed as already sound
(re-verified directly, not assumed from prior reports): credential-stuffing defenses, password-reset
security, MFA architecture, session security, account-enumeration resistance, invitation security
(token entropy, expiration, the PRSprint-31 accept/cancel race fix), agreement immutability, payment
amount authority, ledger append-only enforcement, bank-credential non-persistence (Phase 6A invariants),
webhook signature verification, RLS deny-all pattern, admin self-promotion protection, rate-limiting
architecture, input validation, injection resistance, secrets management, and manual/off-platform
payment authorization.

## 3-9. Vulnerabilities found, severity, root cause, remediation, regression tests

### P0 — `PaymentService.submitPending` had no ownership check (fixed)

**Root cause:** `submitPending(id, actingUserId, ...)` called `findById(id)` and checked only the
payment's *status*, never that `actingUserId` was actually the payment's payer. Both
`AchPaymentService.submitScheduledPayment` and `DebitCardPaymentService.submitScheduledPayment` passed
straight through with no additional check, and both HTTP routes (`/api/ach/payments/submit`,
`/api/debit-card/payments/submit`) only called `requireSession` (any authenticated user), not a
per-payment authorization check.

**Failure scenario:** Any authenticated user who knew or guessed a `scheduled`-status
`payment_attempt` UUID belonging to a *different tenant's* agreement could force it to submit to the
real payment provider early, entirely outside the legitimate payer's control.

**Remediation:** Added a `"payer_only"` mode to `PaymentService.getAuthorizedRecord` (an existing
authorization helper) and switched `submitPending` to use it instead of a bare `findById`.

**Regression tests:** `paymentService.test.ts` (2 new: rejects an unrelated user, rejects the payment's
own recipient — only the payer may submit) + `ach/payments/submit/route.test.ts` (new file, 3 tests) +
`debit-card/payments/submit/route.test.ts` (new file, 3 tests) — proving the fix at both the service and
HTTP layers.

### P1 — `replaceAccount` insert-before-supersede ordering (fixed)

**Root cause:** `RelationshipFinancialAccountService.replaceAccount` inserted the new "active"
assignment row *before* marking the prior one "superseded." The database has a real partial unique
index (`relationship_financial_account_active_slot_unique`, only one active row per
(relationshipId, usage)) — this ordering would violate that index on **every real, non-racing**
replacement in production, not only under a race. This was masked entirely by the in-memory test fake,
which never enforced the same constraint.

**Failure scenario:** The first real production bank/payout-account replacement for any relationship
would have thrown a raw, unhandled database constraint error instead of succeeding.

**Remediation:** The new assignment's id is now generated in application code (`randomUUID()`) so the
prior row can be marked superseded *first*, then the new row inserted as active — at no point do two
active rows coexist. `insertAssignment`'s interface gained an optional `id` field (both
`DrizzleRelationshipFinancialAccountRepository` and the in-memory fake updated). The in-memory fake was
also corrected to enforce the same partial-unique-index behavior as the real database, so this class of
bug cannot hide behind an inaccurate fake again. A companion gap — a genuine concurrent race between two
`replaceAccount` (or `assignAccount`) calls — previously surfaced as a raw DB error for the loser; both
methods now catch that and re-check, returning a clean `ConflictError` instead.

**Regression tests:** `relationshipFinancialAccountService.test.ts` — the pre-existing "supersedes the
prior assignment" test caught the ordering bug immediately once the fake was corrected (it failed before
the fix, passed after); a new `Promise.allSettled`-based concurrency test proves exactly one winner, a
clean `ConflictError` for the loser, and never two active rows for the same slot.

### P1 — MFA step-up not enforced on bank-connection changes (fixed)

**Root cause:** `docs/SECURITY_MODEL.md` threat #16 (payout redirection) explicitly requires elevated
MFA before a bank/payout-detail change, and this codebase already has a proven `requireStepUp` pattern
used for signing, settlements, staff actions, and admin actions — but `BankConnectionService.
connectBankAccount` and `RelationshipFinancialAccountService.replaceAccount` never called it.

**Failure scenario:** An attacker who obtained a stolen but still-valid session (without also
compromising MFA) could connect a new bank account or redirect an existing relationship's payout
destination without a fresh step-up challenge.

**Remediation:** Both methods now require a fresh step-up (`requireStepUp`) before proceeding, checked
*after* ownership/authorization (so a stranger never even reaches a step-up prompt for an account they
don't own) — mirroring `SignatureService.sign`'s established ordering.

**Regression tests:** `bankConnectionService.test.ts` (2 new: rejects without step-up, still rejects a
stranger with `ForbiddenError` before ever prompting for step-up) + `relationshipFinancialAccountService.
test.ts` (1 new). Route-level test (`bank/connect/route.test.ts`) updated to grant step-up so its
existing success-path assertions remain valid.

### P2 — Webhook stale/out-of-order event could regress a terminal payment status (fixed)

**Root cause:** `PaymentWebhookService.applyEvent` applied `EVENT_TYPE_TO_STATUS` unconditionally
regardless of the payment's *current* status. A stale, differently-typed webhook (e.g., a delayed
`payment.failed` arriving after `payment.refunded` already posted) is not caught by the existing
`(provider, providerEventId)` replay dedup (different event, different id) and would regress the
status field, re-running downstream side effects for the wrong state.

**Why P2, not P1:** `LedgerService.postPaymentCleared`/`reversePayment` already dedupe financial
effects per `(paymentAttemptId, entryType)` independently — this was a status-field/audit-trail
integrity gap, never a double-financial-effect risk.

**Remediation:** Added a `TERMINAL_PAYMENT_STATUSES` guard (`failed`, `returned`, `reversed`,
`refunded`, `canceled` — matching `docs/PAYMENT_STATE_MACHINE.md`'s documented terminal states) that
short-circuits and logs `payment_webhook_stale_event_ignored` instead of applying a stale transition.
`disputed` and `succeeded` are deliberately excluded — both have real documented forward transitions.

**Regression test:** `paymentWebhookService.test.ts` — succeeded → refunded → a stale delayed `failed`
event is ignored, status stays `refunded`, no duplicate audit entry for the ignored event.

### P2 — Transaction-limit enforcement architecture incomplete (built)

**Root cause:** PRSprint 33 built only a per-transaction maximum; its own doc comment explicitly flagged
daily/rolling-window limits as unbuilt, requiring a new aggregate-query repository method.

**Remediation:** Added `PaymentAttemptRepository.listRecentByPayer` (Drizzle + in-memory implementations)
and wired a rolling-24h daily amount limit (excludes failed/canceled attempts — they never moved money)
and a rolling-24h daily attempt-count limit (includes failed attempts — a velocity/card-testing-abuse
control) into `PaymentService.reserveAttempt`, after the existing idempotent-replay short-circuit so a
retried request for an already-created payment is never blocked by its own prior activity.

**Classification: PRODUCT OWNER CONFIGURATION REQUIRED** for the actual numeric values — the defaults
($50,000/day, 20 attempts/day) are the same kind of conservative placeholder as the pre-existing
per-transaction cap, not an approved business decision. New-account and high-risk-account restrictions
(the remaining two master-spec item 154 sub-items) were deliberately not built as additional numeric
knobs — doing so without a real account-age or risk-signal integration would be inventing financial
policy, not building enforcement architecture; `reserveAttempt` remains the single choke point, so
wiring either in later is additive.

**Regression tests:** `transactionLimits.test.ts` (4 new) + `paymentService.test.ts` (6 new: exceeds
daily amount, excludes failed-attempt amounts, excludes activity older than the rolling window, exceeds
daily count, still counts failed attempts toward count, never re-runs the check against an idempotent
replay).

### P2 — Fraud/risk signal model entirely missing (built)

**Root cause:** Confirmed by direct repo-wide grep — zero matches for `risk_event`/`fraud_signal`/
`RiskEvent` anywhere in `src/` before this sprint. Master-spec §12/§13 explicitly call for this.

**What was built:** `risk_event` table (append-only except for review-decision fields; RLS
deny-all, matching this schema's established convention) + `RiskEventService`/
`DrizzleRiskEventRepository` + two admin-only API routes (`GET /api/admin/risk-events`,
`POST /api/admin/risk-events/review`), gated by the `review_fraud_alert` capability
`adminCapabilities.ts` had already declared for exactly this purpose ("so Sprint 19 has an existing
capability to gate against rather than inventing a competing one") — enforced inside the service
itself via `AdminRoleService.requireCapability`, matching `AdminCaseReviewService`'s identical
established pattern (a `platform_owner` bypasses immediately; a bare `platform_admin` platform-role
alone is *not* sufficient — it also needs a separately-assigned internal admin role, e.g. `admin` or
a future dedicated `fraud_reviewer`). Recording a signal never blocks, restricts, or otherwise
affects the triggering action — this is a signal ledger, not an enforcement mechanism, per the
spec's own "do not automatically accuse" instruction.

**Concrete integrations wired this pass:** `frequent_bank_connection_change` (on every real
`replaceAccount`, not the idempotent no-op) and `repeated_payment_failure` (on every webhook-driven
`failed` transition). Both are optional dependencies (`riskEvents?:`), never fail the primary action on
recording failure (try/catch + log), matching this codebase's established "never fail the webhook on a
secondary side-effect" contract.

**Deliberately not wired this pass:** `repeated_authentication_failure`, `high_value_action_new_account`,
`invitation_velocity`, `unusual_admin_activity` — the enum/schema/service already model all six signal
types named in the detailed spec, but connecting every one to a live call site (with its own,
non-invented threshold logic) is additive follow-up work, not required to prove the architecture is
real. Two concrete, financially-relevant integrations were chosen deliberately over shallow coverage
of all six.

**Regression tests:** `riskEventService.test.ts` (9), `admin/risk-events/route.test.ts` (3),
`admin/risk-events/review/route.test.ts` (4), plus integration assertions in
`relationshipFinancialAccountService.test.ts` and `paymentWebhookService.test.ts`.

### P2 — `nanoid` high-severity dependency advisory (fixed)

Transitive via `postcss` (a `next` build-time dependency, not runtime-reachable by user input).
`npm audit fix` (non-breaking — a patch-level lockfile bump, `package.json` unchanged) resolved it
cleanly: `npm audit --omit=dev` now reports zero vulnerabilities at any severity.

**Not fixed, documented instead:** a separate moderate `esbuild` advisory, transitive via
`drizzle-kit` (a dev-only migration-generation tool, not shipped to production). Resolving it requires
`npm audit fix --force`, which would downgrade `drizzle-kit` to `0.18.1` — a breaking change to a tool
this project's entire migration history depends on. Per this sprint's own explicit instruction ("do not
blindly upgrade major dependencies... document compatibility risk"), this was not forced. Accepted,
documented risk: dev-time-only, moderate severity.

## 10. Regression tests

See each finding's own "Regression tests" line above for what's new. All new and pre-existing tests
pass — see §34 (Full regression).

## 11-19. Control-area results

**Account takeover controls:** re-verified sound, no changes needed — rate limiting (per-IP and
per-email), MFA (TOTP + SMS, enforced server-side for every sensitive action already using it),
session security (httpOnly/Secure/SameSite, server-side revocation), account-enumeration resistance
(constant-response-shape login/reset), self-service device/session visibility. One disclosed gap: no
new-device/unfamiliar-login notification (P3, not built).

**Fraud controls:** the new `risk_event` model (§3-9 above) plus the pre-existing
`payment_flagged_for_review` (PRSprint 33) and closed-beta invite-code gating (PRSprint 33).

**Payment abuse controls:** re-verified sound (server-side amount validation, agreement-party
cross-check, overpayment protection) plus the new daily amount/count limits and the P0 IDOR fix.

**Bank connection controls:** Phase 6A non-persistence invariants re-verified intact (zero
routing/account-number columns anywhere in the schema); ownership/disconnect/replace authorization
re-verified sound; the P1 ordering bug and the MFA step-up gap were the two real findings, both fixed.

**Webhook/provider controls:** signature verification and replay dedup re-verified sound across all
three provider types (payment/KYC/card); the P2 stale-event guard was the one real gap, now fixed;
provider environment separation (`assertProviderEnvironmentConsistency`) re-verified sound.

**Rate limiting:** re-verified sound and already well-differentiated (~25 call sites, distinct limits
per operation category). Documented fail-open-on-store-failure behavior is a pre-existing,
PRSprint-11A-protected, deliberate tradeoff — see `src/lib/rate-limit.ts`'s own doc comment. Not
changed. One disclosed gap: no explicit rate limit on webhook endpoints or scheduler/cron routes —
acceptable, since those are gated by signature verification / `CRON_SECRET` bearer auth respectively,
not caller identity, but recorded here as an explicit decision rather than silence.

**Transaction-limit architecture:** built this pass (§3-9 above). Actual numeric values remain
PRODUCT OWNER CONFIGURATION REQUIRED.

**Risk-event architecture:** built this pass (§3-9 above).

**Admin hardening:** re-verified sound — no self-promotion path exists anywhere, step-up required for
role changes, financial admin actions (`admin/ledger/adjustment`) derive role server-side, never from
client input. No changes needed.

## 20. Audit hardening

Good baseline coverage confirmed across auth (signup, login failure/success, logout, password reset,
session revocation), MFA (enrollment, disable, step-up pass/fail), role changes, and admin operations.
One gap noted but not fixed this pass: no distinct `password_reset_requested` audit event (only
`password_reset_completed`) — token-issuance itself isn't separately logged. P3, not blocking. Audit
payloads spot-checked for the categories this sprint touched (risk signals, bank-connection
replacement, payment submission) — none include passwords, tokens, or full bank account numbers,
consistent with the existing schema (no such columns exist anywhere to leak).

## 21. Logging redaction

No new logging gaps introduced by this sprint's changes — every new `logger.error`/`logger.warn` call
(P0 fix, stale-webhook guard, risk-signal failures) logs only IDs, status strings, and error messages,
never payment amounts' underlying bank details or credentials (there are none to log). Pre-existing
logging/error-handling architecture (`withErrorHandling`, `toSafeErrorResponse`) re-verified sound —
stack traces never reach the client, only a correlation ID on genuine 5xx faults.

## 22. API hardening

Zod-before-service-logic pattern confirmed on the routes this sprint touched and spot-checked
elsewhere; input validation architecture unchanged (already sound).

## 23. Web-security findings

Confirmed real, fixed this pass: **zero security headers were configured anywhere** in the repository
(no `middleware.ts`, no `next.config.ts` `headers()`, no `vercel.json` headers block) — not a false
negative. Added via `next.config.ts`: `Content-Security-Policy` (`default-src 'self'`; `connect-src`/
`img-src` additionally allow the Supabase storage origin for evidence-document signed URLs, since the
browser never talks to Supabase directly for anything else — no client component imports
`@supabase/supabase-js`), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
(camera/microphone/geolocation/payment all denied). Verified against a real production build and
server: headers present on every response including a 200 page render and a 500 API error; the
rendered HTML confirmed every script/asset is same-origin (no Google Fonts, no CDN, no analytics
script), so the CSP does not break anything observable. **Documented, disclosed limitation:**
`script-src`/`style-src` keep `'unsafe-inline'` rather than a nonce-based strict CSP — Next.js's App
Router emits inline bootstrap scripts, and a nonce-based CSP needs new middleware wiring that would
require full interactive browser QA across every page to verify nothing silently breaks, which this
pass could not do. This still closes the real gap (no CSP/HSTS/frame-ancestors/etc. at all) without
overclaiming a fully strict CSP.

CORS: no explicit configuration exists, which is the secure default for a same-origin app with no
public cross-origin API surface — confirmed not a gap.

## 24. Secret review

No hardcoded credentials found in `src/`. `src/config/env.ts`'s `server-only`-enforced, zod-validated
env schema architecture re-verified sound; no `NEXT_PUBLIC_`-prefixed variable carries anything
sensitive.

## 25. Dependency review

See §3-9 (`nanoid` fixed, `esbuild` documented-not-forced).

## 26-27. RLS results / concurrency & idempotency results

**RLS:** confirmed unchanged and intact — deny-all-for-anon/authenticated across all 36 migrations
(including the two added this sprint), zero real `CREATE POLICY` statements anywhere. Spot-checked
IDOR risk on several lookup-by-id methods (`AgreementService.getAgreement`,
`PaymentService`'s create/manual/confirm/reject paths) — all correctly authorize before returning; the
one real gap found (`submitPending`) is the P0 fix above.

**Concurrency/idempotency:** PRSprint 20's existing 11-scenario adversarial suite re-run — all still
pass. Three additional scenarios this sprint's own instructions specifically named were previously
untested and are now covered: simultaneous bank-connection replacement (found and fixed a real bug,
see §3-9), simultaneous agreement completion (converges to one valid status; one disclosed minor
artifact — see below), simultaneous admin action + user action (an admin ledger adjustment and a
user's payment-clearing webhook for the same agreement each post their own distinct, correctly-typed,
independently-deduped entry — neither clobbers the other). Simultaneous invitation acceptance was
already covered by PRSprint 31's own tests (both `agreementInvitationService.test.ts` and
`relationshipInvitationService.test.ts`) — re-confirmed, not re-built.

**Disclosed minor artifact (P3, not fixed):** `AgreementCompletionService.checkAndAdvance`'s
idempotency guard checks the agreement's status once at the start of each call — under a genuine
concurrent race (two calls both reading the pre-completion status before either writes), both can
proceed and both write `paid_in_full` + record an `agreement_paid_in_full` audit event, producing two
identical audit rows instead of one. The *state* never corrupts (both writes converge to the same
value; this touches no ledger/financial data, which are independently deduped elsewhere) — only the
audit trail could show a harmless duplicate under a true race. A DB-level conditional-update fix would
require changing `AgreementStatusRepository.updateStatus`'s contract, used by other callers not
audited in this pass; fixing it safely is scoped as a small, standalone follow-up rather than risking a
broader repository-interface change this late in an already-large sprint.

## 28. Provider-independent results

All findings and fixes in §3-9 are provider-independent — verified against this codebase's sandbox
providers, requiring no live Twilio, payment, or KYC provider to confirm.

## 29. Provider-dependent blockers

None of this sprint's *own* work is provider-blocked (unlike some architecture-only claims, every
finding here was verified against running sandbox code, not assumed). What remains genuinely
unverifiable without live providers (pre-existing, not new to this sprint):

## 30-31. Twilio-dependent / live-financial-provider-dependent blockers

**BLOCKED — PRODUCTION PROVIDER REQUIRED:**
- Twilio OTP replay/brute-force/resend-abuse behavior under a *live* Twilio account (architecture
  verified sound against the sandbox SMS sender; the actual provider integration has never executed).
- Live financial-provider webhook signature verification and production/test credential isolation
  under *real* provider credentials (architecture — `assertProviderEnvironmentConsistency` — verified
  sound; no live provider is selected, per the pre-existing, unchanged `docs/PRODUCTION_PROVIDER_
  READINESS.md` EXTERNAL BLOCKER).

Neither is marked PASS. Both must be re-run after the respective production activation, per this
sprint's own explicit instruction not to mark a provider-dependent test PASS based solely on mocks.

## 32-35. P0 / P1 / P2 / P3 findings summary

| Severity | Finding | Status |
|---|---|---|
| P0 | `submitPending` had no ownership check (cross-tenant payment forgery) | **Fixed** |
| P1 | `replaceAccount` insert-before-supersede ordering (would break every real production replacement) | **Fixed** |
| P1 | MFA step-up missing on bank-connection creation/replacement | **Fixed** |
| P2 | Webhook stale/out-of-order event could regress a terminal payment status | **Fixed** |
| P2 | Transaction-limit architecture incomplete (daily/rolling-window unbuilt) | **Built** (values: Product Owner configuration required) |
| P2 | Fraud/risk signal model entirely missing | **Built** |
| P2 | `nanoid` high-severity dependency advisory | **Fixed** |
| P3 | No new-device/unfamiliar-login notification | Documented, not built |
| P3 | No disposable-email/duplicate-identity signal at signup | Documented, not built |
| P3 | Name-only invitations rely solely on token secrecy | Documented as intentional (pre-existing) |
| P3 | No app-level webhook payload size limit | Documented, not built (platform backstop exists) |
| P3 | `esbuild` moderate dev-dependency advisory | Documented, not forced (breaking downgrade) |
| P3 | Possible duplicate audit event under a genuine agreement-completion race | Documented, not fixed (no state corruption) |
| P3 | No distinct `password_reset_requested` audit event | Documented, not built |
| P3 | No rate limit on webhook/cron routes specifically | Documented as an accepted, explicit decision |

No P0 or P1 finding remains unresolved. Sprint 19 completion is not blocked.

## 36. Full regression

`npm test` (full suite, includes security-specific/negative-security/RLS/auth/admin/financial/
ledger/provider/webhook/bank-connection/concurrency/idempotency tests — this codebase does not
separate them into distinct suites, they are the same Vitest run): **182 test files, 1360 tests, 1360
passing, 0 failing, no skipped/flaky tests requiring waiver.**

`npm run typecheck`: clean, 0 errors.

`npm run lint`: **0 errors, 8 pre-existing warnings**, scoped to the live `src/` tree — exactly matching
the PRSprint-34-documented baseline, confirming this sprint introduced zero new lint issues. Note: the
plain `npm run lint` command (unscoped) reports a much larger number because `eslint.config.mjs` does
not exclude `.claude/worktrees/**`, a directory of stale, uncommitted git worktrees left over from
prior sessions (predates this sprint). This is a minor tooling-hygiene recommendation, not a code
defect — flagged here rather than silently worked around.

`npm run build`: succeeds cleanly, all routes (including the two new admin risk-events routes) compile
and are listed in the route manifest.

`npm run db:check-migration-safety`: OK, 0 destructive statements across 36 migration files.

`npm run test:tooling`: 15/15 passing.

`npm run db:fresh-migration-test`: could not be run in this sandboxed environment (no local
Postgres/Docker daemon available) — the same documented, pre-existing environment limitation PRSprint
34 recorded. Will run automatically in GitHub Actions CI (a disposable service-container Postgres) on
push/PR, per `.github/workflows/ci.yml`'s `fresh-migration-test` job.

## 37. CI / 38. Vercel / 39. Supabase / 40. Schema drift / 41. Branch / 42. Commits / 43. PR

Recorded once the branch is pushed and CI/Vercel/Supabase results are available — see the tracker
update in `docs/SPRINT_CONTROL.md` for the live values (branch name, commit SHAs, PR number, CI run
result, Vercel deployment result, Supabase schema-drift result against the linked `Paid2You` project).

## Remaining risks

1. Provider-dependent items (§30-31) — genuinely cannot be closed until Twilio and a live financial
   provider are activated.
2. Transaction-limit numeric values — Product Owner configuration required before real-money launch.
3. The disclosed P3 items in §32-35 — none block Sprint 19 completion; each is either accepted,
   scoped for a future pass, or already an intentional design decision.
4. `docs/OPERATIONS_BACKUP_RECOVERY.md`'s DEFERRED Supabase PITR/backup item and the other pre-existing
   external blockers (legal/Sharia review, provider contacts, transaction-limit values) are unchanged
   by this sprint and remain exactly as previously classified — this sprint did not touch them.

## Actions required before Sprint 20

1. Product Owner review of this report and the PR.
2. Merge PR into `master` following the established one-branch-per-phase workflow.
3. Post-merge: verify CI (including the real schema-drift check against the linked production Supabase
   project, which requires `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF` secrets — currently not
   configured in GitHub Actions, a pre-existing gap this sprint did not introduce and did not attempt
   to fix, since configuring repository secrets is a Product Owner action) and Vercel deployment.
3a. Manually verify the two new migrations (`0032_eminent_penance.sql` /
   `20260822090000_sprint19_risk_events.sql`) against the linked production Supabase project via
   `supabase migration list --linked`, the same way Phase 7's post-merge verification did, since the
   GitHub Actions schema-drift check cannot do this without the secrets above.
4. Re-run the two provider-dependent items (§30-31) after Twilio and a live financial provider are
   activated — required before any real-money launch, not before Sprint 20 itself.
5. Do not begin `SPRINT_20_ClosedBetaRediness` until 1-2 are complete and the Product Owner has
   explicitly authorized it.
