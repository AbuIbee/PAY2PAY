# Open Issues

Cross-cutting implementation-time gaps discovered while building a feature, distinct from
`docs/OPEN_DECISIONS.md` (spec-level decisions the master spec itself leaves open). New entries go at
the top.

## B0-D PHASE 3B (payout integrity) — COMPLETE: all five audit gates PASS (2026-09-16)

**Status: PHASE 3B COMPLETE.** All five gates from the read-only audit (G1 security, G2 atomicity, G3
return-accounting, G4 real-PostgreSQL proof, G5 regression) now PASS. B0-D itself remains OPEN and B-1
remains on HARD HOLD — this phase closes the payout-integrity *code* gaps; it does not, and cannot,
supply a live payout provider (see "What's still open" below).

**G1 (security):** unchanged from the prior entry — `PAYOUT_PROVIDER_INTEGRATION_VERIFIED` defaults
`false`; `PayoutService.confirmPayout` checks it first, before any repository access; zero production
callers of `confirmPayout` exist anywhere outside `getPayoutService.ts` and test files (verified by a
full repository-wide trace both in the original audit and again after this phase's changes).

**G2/G3 (atomicity, return-accounting) — what changed:** `src/lib/payouts/atomicPayoutConfirmer.ts` and
`atomicPayoutReturner.ts` (new) — `DrizzleAtomicPayoutConfirmer`/`DrizzleAtomicPayoutReturner`, mirroring
`DrizzleAtomicManualPaymentPoster`'s established "one hand-written `db.transaction`, raw Drizzle queries
against `tx`" pattern. Each performs all required writes (payout_attempt claim via `SELECT ... FOR
UPDATE` + ledger entry/postings + payout_attempt mark + payment_attempt timestamp set/clear) atomically;
the row lock is the concurrency mechanism (a second concurrent call blocks, then observes the first's
already-applied result — proved empirically under real concurrent connections, see G4 below).
`payment_attempt.payoutCompletedAt` is now cleared on return (both in the new atomic path and the
pre-existing non-atomic fallback, via a new `PaymentAttemptRepository.clearPayoutCompleted` method).
`PayoutService` gained optional `atomicConfirmer`/`atomicReturner` deps (mirrors `PaymentService`'s
`atomicManualPayments?` convention exactly); `getPayoutService.ts` always wires the real ones — the only
production construction site.

**G4 (real-PostgreSQL proof) — what changed:** new `src/lib/payouts/payoutService.postgres.test.ts` (8
tests) covers successful confirmation, concurrent confirmation (two genuinely distinct connections,
`Promise.all`, 3 iterations), forced mid-transaction rollback at two separate write boundaries (proving
the ledger entry and the status mark roll back together, never orphaned), successful return, concurrent
+ duplicate returns, forced rollback on the return's ledger correction, and rejection when a payment
never cleared. **Executed against a real, disposable, run-token-verified Postgres container** (`npm run
test:postgres`, never `.env.local` or any pre-existing database) — result, independently confirmed by
this session after Docker became available: **8/8 postgres test files pass, 282/282 tests pass**
(repo-wide, not just this phase's own file — the other 7 pre-existing `*.postgres.test.ts` suites are
unaffected regressions-wise). The disposable container was torn down afterward as designed.

**G5 (regression):** `npm run typecheck` — 0 errors. `npm run lint` — 0 errors, 19 pre-existing,
unrelated warnings. `npm run test` (full in-memory/unit suite) — 251 files / 2189 tests, 0 failures.
`npm run build` — succeeds. `npm run db:check-migration-safety` — OK, 59 files, no destructive
statements. `npm run check-no-sandbox-runtime` — OK, 769 files, no sandbox references. `npm run
test:postgres` — OK, 8/8 files, 282/282 tests (see G4).

**What's still open:** unchanged — no live payout provider integration exists (no Adyen account, no
Balance Platform/Legal Entity Management/Transfers API wiring). `PAYOUT_PROVIDER_INTEGRATION_VERIFIED`
remains unset/false in every real environment, so `confirmPayout` remains unreachable in production by
construction AND by this runtime gate — exactly as designed. The next dependency is external, not a
code task: **B-1 — live payout provider selection, contracting, and configuration** must happen before
any Phase 3C work (a real provider-confirmation trigger wired into `confirmPayout`/`returnPayout`, then
an operator explicitly setting `PAYOUT_PROVIDER_INTEGRATION_VERIFIED=true`) can begin.

## B0-D PHASE 3B (payout integrity) — second independent gate wired (2026-09-16)

**Context:** Phase 3A (`src/lib/payouts/`, `payout_attempt` table — see its own doc comment) closed the
"fictional payout completion" defect by making `pending -> confirmed` require caller-supplied
`providerName`/`providerPayoutReference` evidence, structurally unreachable by any code path today (no
live payout provider is wired). `src/config/env.ts` already defined a second, independent gate for this
— `PAYOUT_PROVIDER_INTEGRATION_VERIFIED` — with a doc comment stating `PayoutService.confirmPayout`
"fails closed" on it, but `PayoutService` itself never referenced that flag: the env var existed with no
enforcement, and `PayoutService`'s own doc comment still claimed the block was "by construction, not by
runtime check." This session closed that gap.

**What changed:** `PayoutService.confirmPayout` (`src/lib/payouts/payoutService.ts`) now checks a
constructor-injected `payoutProviderIntegrationVerified` boolean FIRST, before any repository access,
throwing `ProviderNotAvailableError` if false — independent of how complete/valid the caller-supplied
`providerName`/`providerPayoutReference` looks. `recordPayoutOwed`, `failPayout`, and `returnPayout` are
deliberately NOT gated by this flag (they must keep honestly tracking what's owed with no live provider
configured — that remains Phase 3A's whole point). `getPayoutService.ts` wires
`getServerEnv().PAYOUT_PROVIDER_INTEGRATION_VERIFIED` into the constructor; construction itself is never
gated (unlike `getBankConnectionService()`'s `ADYEN_ACH_TOKENIZATION_VERIFIED` gate), since the whole
service must stay usable. New/updated tests (`src/lib/payouts/payoutService.test.ts`,
`src/lib/payouts/getPayoutService.test.ts`): the flag blocks confirmation even with a real pending
attempt and valid-looking evidence, blocks it before ever touching a repository (no attempt need exist),
does not block `recordPayoutOwed`/`failPayout`, and a regression guard confirms the pre-existing
Phase 3A "verified" path still succeeds unchanged. `npm run typecheck`/`lint`/`build` all pass; full
suite 2187/2188 (the one unrelated failure — a pre-existing flaky random-UUID substring collision in
`relationshipFinancialAccountService.test.ts`, untouched by this change — passed on rerun in isolation).

**What's still open:** exactly what `PAYOUT_PROVIDER_INTEGRATION_VERIFIED`'s own doc comment already
says — no live payout provider integration exists (no Adyen account, no Balance Platform/Legal Entity
Management/Transfers API wiring), so this flag remains unset/false in every real environment, and
`confirmPayout` remains unreachable in production by construction AND by this runtime gate. Nothing in
this session attempted or could attempt live verification against Adyen. Flipping this flag to `true` is
an operator action that must only happen after a real, authenticated live-provider integration exists —
never before.

## B0-D TOTAL SANDBOX ELIMINATION remediation (2026-09-15)

**Context:** the 2026-09-15 B0-D production-gate audit found that every financial/KYC/card-issuing
operation in production ran against sandbox/mock providers with no customer-facing disclosure, and that
the prior provider-environment guard explicitly *permitted* sandbox-in-production rather than blocking
it — a release blocker under the "0 production-reachable sandbox implementations" bar. A follow-up
remediation pass removed sandbox provider construction from application runtime entirely: the
capability registry (`src/lib/providers/providerCapabilities.ts`) is now empty, `getPaymentProvider()`/
`getKycProvider()`/`getCardIssuingProvider()` throw `ProviderNotAvailableError` unconditionally, the
sandbox provider classes were relocated to `src/test-support/` (test-doubles only), the admin sandbox
settlement-simulation route was deleted, the customer-facing bank-connection page now shows "Not yet
available" instead of collecting real routing/account numbers, email/SMS no longer silently fall back
to console-only delivery in production, and a CI regression gate
(`scripts/check-no-sandbox-runtime.mjs`) fails the build if any of this is reintroduced.

**What's still open:** this remediation does not, and cannot, resolve the underlying blocker — **no
live financial/KYC/card-issuing provider has been selected, contracted, or approved.** That remains
`EXTERNAL BLOCKER — LIVE FINANCIAL PROVIDER APPROVAL/CONFIGURATION REQUIRED` per
`docs/PRODUCTION_PROVIDER_READINESS.md`, and B-1 (live provider integration) remains on hard hold. Once
this deploys, production SMS notifications will fail closed (not silently succeed) because Twilio has
never been provisioned there (see `docs/ENVIRONMENT_VARIABLES.md`'s matching update) — an operator
decision, not a defect, but one that needs to be made deliberately before/at deploy time.

## Business signup tax-ID verification has no real provider to plug into (2026-09-03)

**Context:** the account-creation/onboarding redesign (Personal + Business signup) collects a
business's tax-ID **type** (EIN/SSN/ITIN) at signup, but deliberately never collects, transmits, or
stores the tax-ID **number** itself.

**Why:** an audit of the existing identity/KYC architecture before implementation found no compliant
mechanism for full tax-ID collection anywhere in this codebase:

- `identity_verification_record` (`src/db/schema/verification.ts`) has a `providerRef` column reserved
  for a real KYC/KYB provider, never populated by any implementation today.
- `KycKybProvider` (`src/lib/kyc/kycProvider.ts`) has **no tax-ID concept at all** — only
  government-ID-document and business-registration-number fields. Its only implementation is
  `sandboxKycProvider.ts`, a mock.
- `business_profile.ein_or_ssn_ref` (`src/db/schema/identity.ts`) already exists as a tokenized/
  encrypted-reference column ("never raw", per its own comment) but has never had anything to populate
  it with.

Per explicit product direction, this feature does not fake a mechanism that doesn't exist: business
signup collects and persists only `business_profile.tax_id_type` (metadata) and leaves
`ein_or_ssn_ref` null. No full tax-ID number is ever accepted by the signup API, logged, audited, or
returned in any response.

**What's needed to close this:** a real, provider-hosted/tokenized tax-ID verification integration —
extending `KycKybProvider`'s interface with a tax-ID submission/verification method backed by an actual
provider — at which point `business_profile.ein_or_ssn_ref` becomes populated with that provider's
token/reference, exactly as its existing column comment already anticipates. This is the same
dependency already tracked at a spec level in `docs/OPEN_DECISIONS.md` items **#16** ("No KYC/KYB
provider named") and **#19** ("Tax information-reporting not represented in architecture") — this entry
is the concrete, implementation-level instance of that same gap surfaced by the signup redesign.
