# Codex P0 Verification Handoff

"PAID2YOU — MASTER P0" (2026-10-03), Section 71. For a later, independent, READ-ONLY verification
pass. Claude did not run Codex and does not claim Codex verification — this document only describes
what exists for Codex (or any other independent reviewer) to check.

## Repository identity

- Worktree root: `C:\Development\PAY2PAY-b2b`
- Branch: `architecture/b2b-organization-workspaces-v2`
- HEAD at the start of this phase: `9e65a6ddfb334df4bf0e261828b4c15b012667b6`
- Working tree: substantial pre-existing uncommitted work from accepted prior phases (B2B
  organization/RBAC foundation, Phase 1/2 production-launch work) PLUS this phase's own new/changed
  files below. Nothing was committed or pushed this phase.

## What changed this phase (Master P0)

### New provider adapters (production-path code, not yet LIVE VERIFIED — see Section 68 vocabulary)

- `src/lib/organizations/middeskBusinessVerificationProvider.ts` — real Middesk adapter.
- `src/lib/organizations/stripePlatformBillingProvider.ts` — real Stripe Billing adapter.

### Provider factories (wiring)

- `src/lib/organizations/getBusinessVerificationProvider.ts` — constructs Middesk when
  `BUSINESS_VERIFICATION_PROVIDER=middesk` and both secrets are present; fails closed otherwise.
- `src/lib/organizations/getPlatformBillingProvider.ts` — constructs Stripe when
  `PLATFORM_BILLING_PROVIDER=stripe` and both secrets are present; fails closed otherwise. Added
  `createBillingPortalSession` to the `LazyPlatformBillingProvider` wrapper.
- `src/lib/providers/providerCapabilities.ts` — `PROVIDER_CAPABILITY_REGISTRY` now holds exactly
  `{ middesk, stripe }` (was empty since the 2026-10-03 Adyen retirement). Adyen is NOT re-added.

### Webhook processing (idempotent, signature-verified)

- `src/db/schema/platformExpansion.ts` — two new tables:
  `business_verification_webhook_event`, `platform_billing_webhook_event` (mirror
  `kyc_webhook_event`'s exact shape).
- Migration: `supabase/migrations/20261003060000_p0_middesk_stripe_webhook_events.sql`.
- Repositories: `businessVerificationWebhookEventRepository.ts` /
  `drizzleBusinessVerificationWebhookEventRepository.ts`,
  `platformBillingWebhookEventRepository.ts` / `drizzlePlatformBillingWebhookEventRepository.ts`.
- Services: `businessVerificationWebhookService.ts`, `platformBillingWebhookService.ts`.
- Factories: `getBusinessVerificationWebhookService.ts`, `getPlatformBillingWebhookService.ts`.
- Routes: `src/app/api/webhooks/business-verification/middesk/route.ts`,
  `src/app/api/webhooks/billing/stripe/route.ts`.

### Billing domain additions

- `PlatformBillingProvider` interface gained `createBillingPortalSession` (Section 29 — Change
  Payment Method via Stripe's hosted portal, never a raw card-entry form this application renders).
- `PlatformBillingService.createPaymentMethodUpdateSession` — new orchestration method.
- `src/app/api/organizations/billing/payment-method/route.ts` — new route.
- `SubscriptionRepository` gained `findByProviderSubscriptionReference` (needed by the Stripe
  webhook service to resolve an incoming subscription id back to the local row) — implemented in
  `DrizzleSubscriptionRepository` and `InMemorySubscriptionRepository` (test fake).

### Configuration

- `src/config/env.ts` — added `MIDDESK_API_KEY`, `MIDDESK_WEBHOOK_SECRET`,
  `MIDDESK_API_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_STARTER_PRICE_ID`/`STRIPE_CORE_PRICE_ID`/`STRIPE_GROWTH_PRICE_ID`/`STRIPE_SCALE_PRICE_ID`.
  All optional at the schema level, enforced at point of use — same established pattern as every
  other provider secret in this file.
- `docs/PRODUCTION_LAUNCH_CONFIG_MANIFEST.md` updated to move Middesk/Stripe from "not yet
  implemented" placeholders into LAUNCH_REQUIRED, matching the new factory wiring.
- `scripts/check-production-readiness.mjs` + `scripts/check-production-readiness.test.mjs` — new
  CLI readiness report (names/presence only, never values; never claims LIVE VERIFIED).
- `package.json` — added `stripe` dependency; added `production-readiness` npm script.

### Dependency added

- `stripe` (official Node SDK) — no other new runtime dependency.

### Operator documentation (new)

- `docs/PRODUCTION_LAUNCH_RUNBOOK.md`
- `docs/OWNER_LAUNCH_ACTIONS.md`
- `docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md`
- `docs/PRODUCTION_LEGAL_REVIEW.md`
- `docs/CODEX_P0_VERIFICATION_HANDOFF.md` (this file)

### Not changed this phase

- Feature gating / navigation (`src/components/AppNav.tsx`) — audited, already correctly hides
  Payments/Reports/Reconciliation/Documents/Audit/Integrations and shows Billing & Subscription;
  no change needed.
- Adyen retirement itself — already complete from the prior phase; this phase only re-verified it
  (see "Adyen retirement checks" below) and added the two new registry entries alongside it.

> **Superseded by the P0 CLOSURE REMEDIATION phase below:** the line above this phase originally had
> here — "the four legal page components... audited, found already vendor-agnostic and accurate; no
> edit needed" — was true of their LEGAL CONTENT, but missed that all four still rendered
> `LegalPlaceholder`'s own development-placeholder banner to every production visitor. That is now
> fixed; see "P0 CLOSURE REMEDIATION (account-switch continuation)" below.

---

# P0 CLOSURE REMEDIATION (account-switch continuation, same day)

A later Claude session, continuing after the previous one hit its usage limit mid-edit, closed the
repository-controlled P0 items a Senior Architect review (ChatGPT, acting as Paid2You's Technical
Program Owner) had identified as still open after the Master P0 phase above. Still did not run Codex,
commit, or push. Recovery snapshot:
`.recovery/account-switch-p0-closure-20261003/` (excludes `.env*`/`node_modules`/`.next`/`coverage`).

## What was found already complete (verified, not redone)

- **Middesk `in_review` mapping** (`middeskBusinessVerificationProvider.ts`'s `mapMiddeskStatus`):
  `open`/`pending`/`in_audit` → `pending`, `in_review` → `review_required` (a safe non-verified
  state), `approved` → `verified`, `rejected` → `rejected`. `BusinessActivationService` requires
  `verificationStatus === "verified"` exactly — `review_required` structurally can never activate a
  Business. Explicit adapter test already existed:
  `middeskBusinessVerificationProvider.test.ts:117-120`.
- **Middesk verification audit events** (`businessVerificationService.ts`): `submit()` and
  `applyVerificationResult()` already recorded `BUSINESS_VERIFICATION_SUBMITTED`/
  `_REVIEW_REQUIRED`/`_APPROVED`/`_REJECTED` through the existing `AuditService` — never the raw
  EIN/TIN, never a provider secret. Redundant re-applies of the same status are not re-audited (only
  a genuine transition is), and the webhook service's own (provider, providerEventId) dedupe already
  prevents a replayed delivery from calling `applyVerificationResult` a second time at all.

## What this phase actually closed

### D. Real hosted Stripe Checkout billing flow (was mid-edit when the prior account hit its limit)

The interface (`platformBillingProvider.ts`) already declared `createCheckoutSession`/
`retrieveSubscriptionPaymentMethod` before this phase started — `StripePlatformBillingProvider`,
`SandboxPlatformBillingProvider` (test double), and `LazyPlatformBillingProvider` did NOT implement
them yet, so `npx tsc --noEmit` failed with 32 errors at the start of this phase (every file that
constructs one of those classes). This phase:

- Implemented `StripePlatformBillingProvider.createCheckoutSession` (real `stripe.checkout.sessions.create`,
  `mode: "subscription"`, a short-lived per-customer-per-plan idempotency key) and
  `retrieveSubscriptionPaymentMethod` (retrieves the subscription's real `default_payment_method`,
  expanded; throws `ConfigurationError` rather than fabricating one if absent).
- Implemented the matching sandbox test-double methods plus a `simulateCheckoutCompleted(...)` test
  helper that mirrors a real webhook completing the flow — session creation alone never starts a
  subscription or attaches a payment method, in both the real and sandbox adapters.
- `SubscriptionRepository` gained `findByProviderCustomerReference` (`pricingService.ts`,
  `drizzleSubscriptionRepository.ts`, `InMemorySubscriptionRepository`) — the TRUSTED lookup
  `checkout.session.completed` resolves against (the provider customer reference was already
  persisted onto the local row before the Business was ever redirected to Stripe), never a
  client-/payload-supplied organization id.
- `PlatformBillingService.beginHostedCheckout(...)` — new orchestration method: reuses an existing
  provider customer reference (idempotent on retry), rejects `paid2you_business_enterprise` outright
  (`ValidationError`, not an incidental `ConfigurationError`), and returns only `{ hostedUrl }` —
  never marks anything active itself.
- `PlatformBillingWebhookService.syncCheckoutCompleted(...)` (new `checkout.session.completed` case)
  — the ONLY place a hosted checkout's outcome is trusted. Re-fetches the real subscription state and
  payment method from the provider directly (never trusts the webhook payload's own fields beyond
  routing), persists provider references/billing period/payment method/invoices, advances the
  onboarding step marker via the shared `advanceBusinessOnboardingStepIfNeeded` helper (UI
  sequencing only — see below), and records a `PLATFORM_SUBSCRIPTION_ACTIVATED` audit event. The
  existing outer (provider, providerEventId) dedupe in `receiveWebhook` already makes a replayed
  delivery a no-op before `syncCheckoutCompleted` is ever invoked a second time.
- `BusinessOnboardingService.beginHostedCheckout(...)` — new method: ownership check, tier-selected
  gate (mirrors `setUpBilling`), and an explicit required-legal-acceptance gate (`setUpBilling`
  predates that gate and was left unchanged to avoid touching its own already-tested behavior).
  Deliberately does NOT advance the onboarding step itself — only the webhook does, once confirmed.
- New route: `POST /api/organizations/onboarding/billing/checkout`
  (`src/app/api/organizations/onboarding/billing/checkout/route.ts`) — `successUrl`/`cancelUrl` are
  SERVER-derived from `APP_URL`, never client-supplied (closes an open-redirect risk too).
- `BusinessOnboardingWizard.tsx`'s `BillingStep` no longer POSTs a hardcoded fake
  `"pending-provider-integration"` payment-method token (the actual code that existed when this phase
  started — the old flow could never have worked against a live Stripe account). It now calls the new
  checkout route and does a full-page redirect to `hostedUrl`; returning from Stripe shows an honest
  "we're confirming with the provider" notice rather than assuming success.

### C. Stripe billing lifecycle audit events (previously zero audit calls anywhere in this domain)

`PLATFORM_BILLING_AUDIT_ACTION` (`platformBillingService.ts`, shared with the webhook service):
`SUBSCRIPTION_STARTED` (`setUpBilling`'s synchronous success path), `SUBSCRIPTION_ACTIVATED`
(webhook-confirmed checkout completion), `PAYMENT_FAILED` (`invoice.payment_failed` webhook),
`CANCEL_AT_PERIOD_END`, `REACTIVATED`, `PLAN_UPGRADED` (upgrade path only — downgrade is already
unreachable from the accepted self-service route). All via the existing `AuditService` — same
pattern as the Middesk audit events above, never a second mechanism.

### I. Removed the production legal-placeholder banner

`src/components/LegalPlaceholder.tsx` no longer renders the `form-status form-status--error`
"This page is a placeholder... has not been reviewed by counsel... do not rely on it" banner to every
production visitor. The four legal pages' own taglines ("...— not yet finalized.") were also reworded
to ordinary, professional copy. The underlying draft/not-yet-approved status is NOT deleted — it
remains fully tracked in `docs/PRODUCTION_LEGAL_REVIEW.md`, which now states explicitly:
**OWNER APPROVED: NO**, **LEGAL APPROVED: NO**, until the owner/counsel actually reviews. No page, and
no document, claims legal/counsel approval anywhere.

### H. Launch-critical email inventory

New: `docs/LAUNCH_EMAIL_INVENTORY.md`. Finding: staff invitations, agreement invitations, agreement
lifecycle notifications, and auth/password-reset are all genuinely PRODUCTION RESEND-capable (one
shared `getEmailSender()` factory, no second/weaker path). Business verification notifications,
Paid2You's own billing/subscription notifications, and onboarding notifications are NOT IMPLEMENTED
(zero `EmailSender`/`NotificationService` call exists in any of those three services) — a real,
documented gap, not a launch blocker by itself (every one of those states is already visible live in
the product UI and/or the provider's own dashboard), flagged for an explicit owner decision.

## What this phase did NOT close (genuinely unresolved — do not treat as done)

- **F. Representative pre-upgrade migration rehearsal** — NOT attempted this phase. Requires standing
  up a disposable database at a genuine pre-upgrade migration point, populating representative
  records across every listed entity, applying the remaining migrations/backfills forward, and
  proving the same logical records survive. `npm run test:postgres` (which applies the FULL migration
  chain to an empty disposable database before testing) is explicitly NOT a substitute for this, per
  the owner's own instruction — a separate rehearsal script/harness would need to be built.
- **G. Supabase cross-tenant document tests** — NOT closed this phase. Investigated the authorization
  path: `SignatureService.getSignedPdfUrl(agreementId, actingUserId)` re-runs full authorization via
  `AgreementService.getAgreement` before ever asking `DocumentStorage` for a signed URL (confirmed by
  reading `signatureService.ts`'s own doc comments) — `DocumentStorage` itself
  (`src/lib/documents/documentStorage.ts`) has only `uploadPrivate`/`createSignedUrl`, no
  delete/overwrite method at all, so "overwrite"/"delete" are not operations that exist to test
  against for this document type. No existing test exercises this specific path with two different
  organizations' agreements (`agreementWorkspaceTenancy.postgres.test.ts` proves `organization_id`
  row-level tenancy for agreement creation/lookup, not the signed-PDF-URL path specifically). A real
  test needs to be added at the `SignatureService`/`AgreementService` boundary, not fabricated here.
- Stripe/Middesk adapters remain CODE COMPLETE, not LIVE VERIFIED (unchanged from the Master P0
  phase above — no credentials exist in this environment to change that).

## Updated validation results this phase

```
npx tsc --noEmit                         # clean, 0 errors (was 32 errors — the interface/implementation
                                          #   gap from the prior account's mid-edit stop — at phase start)
npx eslint .                             # 0 errors, 35 warnings (all pre-existing underscore-prefixed
                                          #   unused-param convention; none introduced by this phase)
npm run build                            # succeeds; includes the new
                                          #   /api/organizations/onboarding/billing/checkout route
npx vitest run --exclude '**/*.postgres.test.ts'
                                          # 2891/2892 passed — the 1 failure is the SAME accepted baseline
                                          #   (AgreementCreateWizard.test.tsx, line 249) called out below;
                                          #   zero new failures
node --test scripts/check-production-readiness.test.mjs   # 8/8 passed
npm run test:tooling                     # 100/100 passed (migration-safety, sandbox-runtime,
                                          #   schema-drift, postgres-test-db port/ownership guards)
npm run test:postgres                    # 332/332 passed, 13 files — applies the FULL migration chain
                                          #   fresh to a disposable container, so this also re-confirms
                                          #   the fresh-migration proof; includes
                                          #   agreementWorkspaceTenancy.postgres.test.ts (organization_id
                                          #   tenancy) unaffected by this phase's changes
```

No new migration was added this phase (no schema change) — `findByProviderCustomerReference` reads
an existing column (`subscription.provider_customer_reference`, already present from the Master P0
phase above).

## Adyen retirement checks (Section 49) — re-verified, not redone

- `PROVIDER_CAPABILITY_REGISTRY` has exactly two keys: `middesk`, `stripe`. No `adyen` key.
  (`src/lib/providers/providerCapabilities.test.ts`.)
- `getPaymentProvider()` still throws `ProviderNotAvailableError` for `PAYMENT_PROVIDER=adyen` (or
  anything else) in every environment, even with a complete-looking legacy Adyen configuration.
  (`src/lib/payments/getPaymentProvider.test.ts`, re-exercised in
  `src/lib/launch/productionBoot.test.ts`.)
- `getBankConnectionService()` fails closed unconditionally (Adyen was its only mechanism).
  (`src/lib/relationships/getBankConnectionService.test.ts`.)
- No Stripe or Middesk code path routes customer repayment through Adyen, or at all — neither
  adapter implements `PaymentProvider`; TypeScript itself would reject assigning either to that
  interface.
- `scripts/check-no-sandbox-runtime.mjs` passes (900 files scanned) — unrelated to Adyen
  specifically, but confirms no sandbox/mock provider runtime path exists either.
- Remaining Adyen source references (`adyenPaymentProvider.ts`, its webhook routes, ~40 other files
  with historical doc-comment mentions) are unchanged this phase — classified as legacy/dead per the
  owner directive, not touched.

## Feature-gating checks (Section 50/51)

- `src/components/AppNav.tsx` shows exactly: Dashboard, Outstanding Balances, Customers, Agreements,
  Employees, Organization Settings, Billing & Subscription.
- Payments/Reports/Reconciliation/Documents/Audit History/Integrations routes exist (they appear in
  `npm run build`'s route list) but are not linked from navigation — unchanged, pre-existing
  behavior from Phase 2.
- No "Make Payment" or equivalent action exists anywhere in the Business workspace UI.

## Exact validation commands run this phase, and their results

```
npx tsc --noEmit                         # clean, 0 errors
npx eslint .                             # 0 errors, 31 warnings (pre-existing baseline, unchanged)
npm run build                            # succeeds; all routes compile, including the 2 new webhook routes + payment-method route
npx vitest run                           # 2856/2857 passed — the 1 failure is the pre-existing accepted
                                          #   baseline failure (AgreementCreateWizard.test.tsx, "...creates a
                                          #   draft and navigates", line 249, TestingLibraryElementError)
npm run test:postgres                    # 332/332 passed, 13 files (run twice during this phase; both green —
                                          #   this harness applies the full real migration chain, including the
                                          #   new 20261003060000 migration, to a disposable Postgres container
                                          #   before running, so it also doubles as the fresh-migration proof)
npm run db:check-migration-safety        # OK — 66 migration files, no destructive statements
npm run check-no-sandbox-runtime         # OK — 900 application source files scanned
node --test scripts/check-production-readiness.test.mjs   # 8/8 passed
```

## Security / sensitive-data invariants to re-check independently

- Raw EIN/Tax ID: never persisted (no column exists anywhere in `src/db/schema` for it — only
  `tax_id_last4`), never logged (`middeskBusinessVerificationProvider.ts` has no logging call that
  includes the request body), never returned from any adapter method.
- Raw card data: never collected by this application — `StripePlatformBillingProvider.attachPaymentMethod`
  only ever receives an already-tokenized Stripe PaymentMethod id; there is no code path that
  constructs a Stripe `PaymentMethod` from raw card fields.
- Webhook secrets: `MIDDESK_WEBHOOK_SECRET`/`STRIPE_WEBHOOK_SECRET`/every other provider secret is
  read only from `getServerEnv()`, never logged, never returned in any API response.
- Cross-tenant safety: every webhook handler resolves the local organization/subscription via a
  TRUSTED stored provider reference (`findByProviderReference`/`findByProviderSubscriptionReference`)
  — never from a client- or webhook-payload-supplied organization id.

## Claims requiring independent/operator verification (this phase could not verify these itself)

- Middesk's exact current API request/response shapes and webhook signature convention were
  confirmed against Middesk's own published documentation (`docs.middesk.com`) at the time of
  writing, not against a live authenticated call (no Middesk account/credentials exist in this
  environment). An operator with real credentials should exercise this adapter against Middesk's
  test mode before the first live verification (see `docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md`).
- The Stripe adapter is built against the official `stripe` Node SDK's well-documented, stable API
  shapes, but has likewise never been exercised against a real Stripe account.
- `docs/PRODUCTION_LEGAL_REVIEW.md` lists specific, unresolved owner/counsel decisions — Codex
  should not treat the four legal pages as approved; they are not.

## Accepted historical baseline failure (do not re-report as new)

`AgreementCreateWizard.test.tsx` — "...creates a draft and navigates" — line 249 —
`TestingLibraryElementError`. Pre-existing before this phase; unrelated to any change made here.

## Claude's own scope boundary this phase (Section 70/74 compliance)

Not built, by explicit instruction: FedNow/RTP/Request-for-Payment rail implementation, direct bank
connection/settlement code, advanced Reports/Reconciliation/Documents/Audit-History UI, an
Integrations marketplace, Twilio/SMS activation, a homepage redesign, or any change to the accepted
RBAC/tenancy/agreement-authorization baseline.

---

# FINAL TWO P0 CLOSURE ITEMS (same day, continuation)

A third Claude session closed the two remaining repository-controlled P0 items a Senior Architect
review had explicitly refused to accept as deferrable: a TRUE representative pre-upgrade migration
rehearsal (Item F), and an executable cross-tenant signed-document authorization proof (Item G). Did
not commit, push, or run Codex. No accepted architecture (Section 1 of that order) was reopened or
redesigned — only two new, additive artifacts were created.

## Item F — representative pre-upgrade migration rehearsal

**New files:**
- `scripts/run-production-upgrade-rehearsal.mjs` — the orchestrator. Owns a disposable Postgres
  container's full lifecycle (reusing `scripts/postgres-test-db.mjs`'s own container-safety utilities
  — generateContainerName/buildDockerRunArgs/buildDatabaseUrl/parseDockerPortOutput/
  finalizeHarnessRun/validateRequestedPort/validateResolvedTarget — never a second, competing
  Docker-safety implementation), applies migrations in two phases, and spawns the two tsx phases
  below.
- `scripts/productionUpgradeRehearsal.ts` — the `--phase=seed` and `--phase=verify` logic, run via
  `tsx --conditions=react-server`. Uses this repository's own real repositories/services
  (`seedPersonalUser`, `DrizzleBusinessCustomerRepository`, `DrizzleBusinessObligationRepository`,
  `DrizzleLegalAcceptanceRepository`, `AgreementWorkspaceService.createDraftForWorkspace`,
  `DrizzleOrganizationRoleRepository`) — never hand-rolled raw SQL for anything with a real insert
  path already.

**Run with:**
```
npm run db:upgrade-rehearsal
```
(equivalently `node scripts/run-production-upgrade-rehearsal.mjs`). Independently runnable, no source
modification needed, tears its own container down on every exit path (success, failure, or signal).

**PRE-UPGRADE CUT POINT:** `supabase/migrations/20261002030000_business_onboarding_fields.sql`
(applied THROUGH this file; the very next file,
`supabase/migrations/20261003040000_final_rbac_role_id_constraints.sql`, is deliberately NOT applied
yet at seed time). This is the one and only point in the entire migration chain where
`business_staff_member.role_id`/`business_staff_invitation.role_id` exist (added by
`20261002010000_b2b_platform_expansion_schema_completion.sql`) but carry no CHECK constraint yet
(that constraint is added by the very next file) — see
`scripts/run-production-upgrade-rehearsal.mjs`'s own `CUT_POINT_FILE` doc comment for the full
reasoning (every representative entity Item F requires is already constructible by this exact point;
choosing anything later would skip exercising the single riskiest remaining migration; choosing
anything earlier would not unlock any additional entity).

**What the rehearsal actually proves (all assertions execute, nothing is "preserved indirectly"):**
1. Seeds two organizations against the historical schema: Org 1 with an Owner membership and a
   Finance-Admin membership (both role_id NULL — genuinely historical, pre-cutover rows), a pending
   staff invitation (role_id NULL), a THIRD membership whose role_id is ALREADY resolved to a
   hand-crafted custom role (proves the backfill leaves an already-resolved row untouched), a
   pre-seeded `paid2you_business_core` pricing_plan row (before the production-catalog migration
   formalizes the full catalog), an active subscription on that plan, a subscription_usage row, a
   business_customer + business_obligation pair, a real agreement (via
   `AgreementWorkspaceService.createDraftForWorkspace`, organization-scoped), and a legal_acceptance
   row. Org 2 exists solely to prove cross-tenant non-contamination.
2. Attempts `20261003040000_final_rbac_role_id_constraints.sql` BEFORE any backfill — asserts it
   FAILS (`business_staff_member_active_role_id_required` violated) — proving the backfill is
   genuinely required, not decorative. The failed attempt's own transaction rolls back cleanly (each
   migration file is one simple-query-protocol transaction), so re-applying it later is safe.
3. Runs the REAL `npm run db:backfill-legacy-roles` script (not a reimplementation) via
   `LegacyRoleMigrationService.migrateAllOrganizations()` — asserts memberships/invitations backfilled
   > 0 — then runs it AGAIN immediately — asserts exactly 0 additional rows backfilled (idempotency).
4. Applies every remaining migration in normal order — the role_id-constraint migration now succeeds
   for real.
5. Verifies (all of the following are individually asserted, see the script's own `expect()` calls
   and their console output): USER, PERSONAL PROFILE, ORGANIZATION, OWNER, MEMBERSHIP, ADDITIONAL
   MEMBER, ROLE_ID (non-null, correct organization, protected Owner), the already-resolved custom-role
   membership untouched, the pending invitation backfilled, exactly one "Owner" and one "Finance
   Administrator" role per organization (no duplication from the double backfill run), CUSTOMER,
   BALANCE/OBLIGATION (same amounts), AGREEMENT (same `organization_id`), SUBSCRIPTION (same
   pricing_plan_id), USAGE (same count), LEGAL ACCEPTANCE, cross-tenant non-contamination (org1/org2
   resolve to DIFFERENT role rows, correctly organization-scoped), the full production commercial
   catalog (`$99/$199/$699/$1,999/$5,000` starting-reference for Starter/Core/Growth/Scale/Enterprise)
   with the pre-seeded `paid2you_business_core` row surviving as the SAME row (not duplicated by the
   migration's own `ON CONFLICT DO NOTHING`), the `business_staff_member_active_role_id_required`/
   `business_staff_invitation_pending_role_id_required` CHECK constraints now genuinely rejecting a
   violating insert, and `platform_billing_webhook_event(provider, provider_event_id)` uniqueness
   genuinely holding (a duplicate insert is rejected).

**Result: PASS.** Full console transcript of a clean run (37 assertions, zero failures, exit code 0,
container torn down) available by re-running `npm run db:upgrade-rehearsal` — every line is logged as
`OK — <assertion>` or `FAIL — <assertion>`, so a reviewer does not need to read the script to confirm
what was checked. Re-run twice during this phase; both clean.

**Explicit constraint note (Section 13):** the DATABASE itself enforces role_id-required (CHECK
constraints, proven above) and provider-event uniqueness (unique index, proven above). "An
organization role cannot cross tenants" is NOT a database-level constraint in this schema (confirmed
by reading `legacyRoleMigration.postgres.test.ts`'s own pre-existing "I" test, which shows a
cross-org `role_id` FK is NOT rejected by the database) — it is an APPLICATION-layer invariant
(`OrganizationPermissionService`, separately already tested in `organizationPermissionService.test.ts`).
Reported precisely rather than fabricating a DB constraint that does not exist.

## Item G — executable cross-tenant signed-document authorization proof

**New file:** `src/app/api/agreements/pdf/route.tenantIsolation.postgres.test.ts` (5 tests, real
Postgres, included in `npm run test:postgres`'s own 14-file/337-test run).

**Production service path exercised (read from the real code, not assumed):**
`SignatureService.getSignedPdfUrl(agreementId, actingUserId)` → `AgreementService.getAgreement` →
`authorizeEitherParty` → `authorizeParty` → (for a BUSINESS party) `StaffService.requireActiveStaff` →
only then `DocumentStorage.createSignedUrl`. The HTTP route
(`GET /api/agreements/pdf`, `createAgreementPdfHandler`) is a thin, already-covered
session/query-param wrapper around exactly this chain with no authorization logic of its own — this
test calls the chain directly rather than also re-implementing an in-memory session store compatible
with a Postgres-seeded user id (see the test file's own doc comment for why that HTTP layer is safe
to skip here specifically). **Every assertion counts `DocumentStorage.createSignedUrl` invocations
directly — a 403 response alone is never treated as sufficient proof.**

**Run with:**
```
npm run test:postgres
```
(runs the full `*.postgres.test.ts` suite including this file), or in isolation once a disposable
database is already running:
```
npx vitest run --config vitest.postgres.config.ts src/app/api/agreements/pdf/route.tenantIsolation.postgres.test.ts
```

**OWN-ORG test:** an active staff member of the agreement's own creditor organization (Business is
the creditor party — the realistic B2B shape, not merely two personal parties) retrieves the signed
URL. Asserts: success, `signedUrlsIssued.length === 1`, and the returned URL encodes the EXACT
server-resolved storage path (never a client-influenced one).

**CROSS-ORG test:** an active, valid staff member of a COMPLETELY UNRELATED organization is denied.
Asserts: `ForbiddenError` thrown, AND `signedUrlsIssued.length === 0` (the mandatory second
assertion — storage is never reached).

**SAME-USER MULTI-ORG test:** a user who is active staff of a different organization only is denied
access to Org A's agreement; the SAME user, once genuinely added as active staff of Org A, is then
authorized — proving the check is driven by real current membership state, never a cached/selected
"workspace context" (there is no organization-context parameter anywhere in
`getSignedPdfUrl`'s own signature to confuse in the first place).

**CLIENT STORAGE REFERENCE SPOOFING:** STRUCTURALLY NOT EXPOSED — `getSignedPdfUrl`'s only inputs are
`agreementId`/`actingUserId`; `GET /api/agreements/pdf` accepts only an `id` query parameter; the
storage path is always resolved server-side from `agreementPdfs.findByVersion(...)`, itself keyed off
the already-authorized agreement's own current version — never from any request field. No public
input anywhere in this chain accepts a storage key/path/document reference at all.

**CROSS-TENANT OVERWRITE:** N/A — NO OVERWRITE CAPABILITY EXPOSED. **CROSS-TENANT DELETE:** N/A — NO
DELETE CAPABILITY EXPOSED. (`src/lib/documents/documentStorage.ts`'s `DocumentStorage` interface has
exactly two methods, `uploadPrivate`/`createSignedUrl` — confirmed by reading the file; no
overwrite/delete method exists to test against.)

**Test storage / production selection:** `InMemoryDocumentStorage`
(`src/lib/documents/testFakes.ts`, pre-existing, unmodified) is the storage-boundary observer —
records every `createSignedUrl` call, returns deterministic URLs, never makes a network call.
`getDocumentStorage()` (`src/lib/documents/getDocumentStorage.ts`) has exactly one unconditional
branch — `new SupabaseDocumentStorage(...)` — asserted directly
(`expect(getDocumentStorage()).toBeInstanceOf(SupabaseDocumentStorage)`): the in-memory fake can
never be production-selected. No live Supabase credentials or network calls were used anywhere in
this item, per the owner's own explicit instruction.

**Result: PASS** — 5/5 tests, real Postgres, zero regressions to the other 332 pre-existing Postgres
tests (337/337 total after this item).

## Updated validation results (Items F/G closure phase)

```
npx tsc --noEmit                         # clean, 0 errors
npx eslint .                             # 0 errors, 35 pre-existing warnings (unchanged)
npm run build                            # succeeds
npm run db:upgrade-rehearsal             # PASS — Item F, run twice, both clean, exit 0
npm run test:postgres                    # 337/337 passed, 14 files (was 332/13 — +5 Item G tests,
                                          #   zero regressions) — this run IS the fresh-migration-chain
                                          #   proof too (full chain applied to an empty disposable DB)
npx vitest run --exclude '**/*.postgres.test.ts'
                                          # 2891/2892 passed — the same single accepted baseline
                                          #   failure, zero new failures
node --test scripts/check-production-readiness.test.mjs   # 8/8 passed
npm run check-no-sandbox-runtime         # OK — 902 files scanned (Adyen retirement static check)
```

## Repository-controlled P0 status after this phase

All 9 items (A-I) from the Master P0 Closure Remediation checkpoint are now closed: A/B (already
complete), C/D/E/H/I (closed in the prior continuation), F/G (closed in this continuation). No
repository-controlled P0 item remains open. External/owner-controlled items remain exactly as listed
earlier in this document (live Stripe/Middesk credential exercise; the 3 NOT-IMPLEMENTED email
categories; owner/counsel legal sign-off).

---

# CODEX P0 DEFECT REMEDIATION (P0-1 through P0-7)

A subsequent Claude session reproduced, fixed, and tested 7 independent defects an earlier, separate
Codex read-only verification pass found in the (by-then-accepted) P0 closure work above. Each is a
real, reproducible defect — not a disputed finding — confirmed by reading the exact pre-fix code
before changing anything, per that pass's own "reproduce it first" instruction. Did not commit, push,
or run Codex. No accepted architecture (RBAC, tenant isolation, Owner protection, agreement
authorization, Personal/Business separation, Middesk, Stripe Billing, Resend, SupabaseDocumentStorage,
commercial pricing, usage metering, legal acceptance, hosted Stripe Checkout, Payments-hidden, Adyen
retirement) was reopened or redesigned — every fix is additive or narrows an existing gap.

## P0-1 — production migration/backfill ordering

**Root cause (confirmed by reading the code):** the documented runbook applied every pending
migration — including `20261003040000_final_rbac_role_id_constraints.sql` — before running the
legacy-role backfill script, when that migration's own CHECK constraints require the backfill to have
already run first.

**Fix:** `scripts/run-production-upgrade.mjs` (new) — the one command
(`npm run db:upgrade-production`) that GUARANTEES correct order: detects whether the role_id-required
constraint already exists; if not, DEFERS (reversibly renames, never edits) that migration and
everything after it; applies only the pre-barrier migrations (via the real `supabase db push
--linked`, never bypassed); runs the real backfill script; verifies, by direct query, that zero
active memberships/pending invitations remain with a null `role_id` (hard stop if any do); restores
the deferred files; applies the remainder. Every step is idempotent/resumable.

**Proof:** `scripts/run-production-upgrade-rehearsal.mjs` already proved the underlying mechanics
(unchanged); a NEW `scripts/run-production-upgrade-orchestrator-rehearsal.mjs` proves the orchestrator
SCRIPT ITSELF — seeds a database with genuine pre-existing null-`role_id` rows, then runs
`npm run db:upgrade-production` as a single command (via `PRODUCTION_UPGRADE_APPLY_MODE=direct-sql`,
the disposable-rehearsal substitute for the real `supabase db push --linked` — see that script's own
doc comment), and verifies full preservation + the constraint now holding.

Rerun:
```
npm run db:upgrade-orchestrator-rehearsal
```

**Docs updated:** `docs/PRODUCTION_LAUNCH_RUNBOOK.md` step 4 now names `npm run db:upgrade-production`
explicitly and tells the operator NOT to run `supabase db push --linked`/apply migrations directly.

## P0-2 — Middesk EIN/TIN data exposure

**Root cause:** `MiddeskBusinessVerificationProvider.parseWebhookEvent` returned Middesk's COMPLETE
business object (which can legally carry `tin`/`addresses`/`review.reason` fields) as the webhook's
`data`, which `BusinessVerificationWebhookService.receiveWebhook` then persisted VERBATIM into
`business_verification_webhook_event.payload` (jsonb). Separately, `request()`'s `!response.ok` branch
echoed Middesk's own response body text (`json.message`) directly into a thrown `ConfigurationError`,
which flows into structured application logs via `withErrorHandling`'s generic catch-all.

**Fix:** `parseWebhookEvent` now runs the raw business object through a new
`sanitizeMiddeskWebhookBusinessObject` ALLOWLIST (never a denylist) — only `id`/`status`/`created_at`/
`updated_at` ever survive; `applyEvent` only ever needed `data.id` anyway (status is always re-fetched
live, never trusted from the webhook body). The provider-error branch no longer reads any field off
`json` at all — only the provider name, request path, and HTTP status.

**Proof (synthetic sentinel, never real PII):**
```
npx vitest run src/lib/organizations/middeskBusinessVerificationProvider.test.ts src/lib/organizations/businessVerificationWebhookService.test.ts
```
Specific tests: `"P0-2 (Codex): never echoes Middesk's own error response body text..."`,
`"P0-2 (Codex): webhook business-object persistence is allowlisted..."`, and
`"P0-2 (Codex): persistent webhook-event storage never contains Middesk's raw business object..."` —
each asserts the sentinel appears ZERO times in the persisted record, audit metadata, and thrown
error text.

### RE-VERIFICATION UPDATE (2026-10-04, "SURGICAL FINAL P0 REMEDIATION")

Codex's independent re-verification found the above fix incomplete: it sanitized only the webhook
JSONB payload path. TWO separate leaks remained, both in the SEPARATE, live
`retrieveVerificationStatus` path (not the webhook body):

1. `mapBusinessResponse`'s `failureCode` passed Middesk's raw `review.reason` free text straight
   through — this flows unsanitized into persistent storage (`business_verification.failure_code`)
   and audit `newValue.failureCode` via `BusinessVerificationService.applyVerificationResult`.
2. `request()`'s network-exception catch block interpolated the caught fetch/network error's own
   `.message` into the thrown `ProviderCapabilityUnsupportedError` — which `withErrorHandling`'s
   generic catch-all then logs verbatim.

**Fix:** `mapBusinessResponse.failureCode` is now always a fixed, Paid2You-defined literal
(`"rejected"`) — `review.reason` is no longer read anywhere in this adapter. The network-exception
catch block no longer interpolates the caught error's `.message` at all — only the request path.

**Proof (adversarial sentinel, planted in `review.reason` and in the caught network error's own
message, both asserted to appear ZERO times in the result/thrown-error text):**
```
npx vitest run src/lib/organizations/middeskBusinessVerificationProvider.test.ts
```
New tests: `"never surfaces a sentinel planted in review.reason via failureCode..."`, `"never
interpolates the caught network exception's own message into the thrown error"`. The pre-existing
`"maps 'rejected' with a safe failureCode..."` test is corrected — it previously asserted
`failureCode` equal to the raw provider text `"entity not found"`, which was itself the vulnerable
behavior; it now asserts the fixed literal `"rejected"`.

**Files touched:** `src/lib/organizations/middeskBusinessVerificationProvider.ts`,
`src/lib/organizations/middeskBusinessVerificationProvider.test.ts`. No change to
`businessVerificationService.ts` — it already only forwards whatever `failureCode` it receives.

## P0-3 — webhook failed-delivery permanently suppressed (Middesk + Stripe)

**Root cause:** both webhook services used `findByProviderEvent` (existence check) then `insert` to
decide "new vs. duplicate" — ANY existing row, regardless of `processedAt`, was treated as a permanent
duplicate. A delivery whose first processing attempt threw (after the row was inserted) could never be
retried again, silently losing the verification/subscription/invoice transition and its audit event
forever.

**Fix:** replaced with ONE atomic `claimEvent` method per repository
(`DrizzleBusinessVerificationWebhookEventRepository`/`DrizzlePlatformBillingWebhookEventRepository`),
built on `INSERT ... ON CONFLICT (provider, provider_event_id) DO UPDATE ... WHERE processed_at IS
NULL AND (claimed_at IS NULL OR claimed_at < stale-threshold) ... RETURNING`. A new additive
`claimed_at` column (migration `20261004010000_webhook_event_retry_claim.sql`) backs this. Both
webhook services now: claim → process → markProcessed, with "duplicate" meaning ONLY "already
successfully processed, or another delivery is actively/recently claiming it" — never "a row merely
exists."

**Proof (service-level, both providers, including genuine concurrency via `Promise.all`):**
```
npx vitest run src/lib/organizations/businessVerificationWebhookService.test.ts src/lib/organizations/platformBillingWebhookService.test.ts
```
**Proof (real Postgres row-level locking, both repositories):**
```
npm run test:postgres   # includes src/lib/organizations/webhookEventClaim.postgres.test.ts (5 tests)
```

## P0-4 — canceled Stripe subscription could activate a Business

**Root cause:** `PlatformBillingWebhookService.syncCheckoutCompleted` fetched the authoritative
`state.status` from the provider but never checked it before advancing the onboarding step
(`billing_setup_complete` — one of `BusinessActivationService`'s four required activation facts) and
recording `SUBSCRIPTION_ACTIVATED`.

**Fix:** both `syncCheckoutCompleted` and `syncSubscriptionPeriod` now compute
`state.status === "active"` and route through a shared `activateOnboardingIfNeeded` helper that ONLY
advances onboarding/audits activation when genuinely eligible. Provider references/billing
period/payment method are still synced unconditionally (so a later legitimate event — e.g. a
subsequent `customer.subscription.updated` once Stripe confirms eligibility — can still correlate and
activate; proved explicitly).

**Proof:**
```
npx vitest run src/lib/organizations/platformBillingWebhookService.test.ts
```
Describe block `"P0-4 (Codex): checkout.session.completed proves the hosted flow completed, NEVER
activation eligibility on its own"` — active → eligible; canceled/payment_failed (covers
incomplete/incomplete_expired/unpaid)/past_due/suspended (covers paused) → NOT eligible, no onboarding
advance, no audit, provider references still synced; plus a later `customer.subscription.updated`
reporting genuine `active` activates a previously-withheld organization exactly once.

### RE-VERIFICATION UPDATE (2026-10-04, "SURGICAL FINAL P0 REMEDIATION")

Codex's independent re-verification found the above fix incomplete: `state.status === "active"` was
the right check, but `mapStripeSubscriptionStatus` already collapsed Stripe's `trialing` status into
the SAME internal `"active"` value before that check ever ran — Paid2You has no approved trial
product, so a `trialing` Stripe subscription silently passed the eligibility gate.

**Fix:** `ProviderSubscriptionStatus` gained a distinct `"trialing"` member;
`mapStripeSubscriptionStatus` now maps Stripe's `trialing` to this new value instead of `"active"`.
No change was needed to either activation gate (`syncCheckoutCompleted`/`syncSubscriptionPeriod`) —
both already compared against the literal `"active"` string, so `trialing` is now correctly rejected
by the existing comparison.

**Proof:**
```
npx vitest run src/lib/organizations/stripePlatformBillingProvider.test.ts src/lib/organizations/platformBillingWebhookService.test.ts
```
New tests: `"P0-4: maps 'trialing' to its own distinct status, never 'active'..."`; the
checkout-completion matrix now includes `"trialing (no approved Paid2You trial product exists)"`
alongside canceled/payment_failed/past_due/suspended; a new test proves the SECOND activation entry
point (`customer.subscription.updated` → `syncSubscriptionPeriod`) also denies `trialing`.

**Files touched:** `src/lib/organizations/platformBillingProvider.ts`,
`src/lib/organizations/stripePlatformBillingProvider.ts`,
`src/lib/organizations/stripePlatformBillingProvider.test.ts`,
`src/lib/organizations/platformBillingWebhookService.test.ts`.

## P0-5 — onboarding tier reentry bypassed billing

**Root cause:** `BusinessOnboardingService.selectTier` had only a LOWER-bound step check
(`verification_submitted`) — it remained callable at ANY later onboarding step, including after real
billing was already established, letting a caller freely cancel-and-replace the local subscription row
(any plan, including Enterprise) with zero provider involvement.

**Fix:** `selectTier` now also rejects when `onboardingStep === "billing_setup_complete"` (onboarding
already genuinely completed, post-P0-4) OR when the current subscription already carries a real
`providerSubscriptionReference` (a checkout already completed for it, even if not yet eligible) — all
such cases must go through Billing & Subscription's own provider-backed `changePlan` instead. Enterprise
is rejected outright at this step too, mirroring the existing change-plan/checkout rejections.

**Proof:**
```
npx vitest run src/lib/organizations/businessOnboardingService.test.ts
```
Describe block `"P0-5 (Codex): onboarding tier reentry cannot bypass billing"` — Starter/Core/Growth/
Scale selectable pre-subscription; Enterprise rejected; tier selection never attaches a provider
reference; `billing_setup_complete` blocks reentry (zero unauthorized local subscription replacement,
verified by row identity); an active Starter cannot reenter to select Enterprise; an active Growth
cannot reenter to downgrade; a subscription with a real (even non-eligible) provider reference also
blocks reentry; wrong-org/nonmember denied.

### RE-VERIFICATION UPDATE (2026-10-04, "SURGICAL FINAL P0 REMEDIATION")

Codex's independent re-verification found the above fix incomplete: it only blocked RE-ENTRY into
`selectTier`. It did not address that `subscription.status` (the local DB column) defaults to
`"active"` the instant `selectTier` creates the row — before any Stripe involvement at all — and
`EntitlementService.entitled`/`getEntitlementLimit` (the actual production paid-feature gate,
consumed by `AgreementWorkspaceService.createDraftForWorkspace` for organization-scoped agreement
creation) granted entitlement from that row alone. An organization could select a tier, then
immediately create/send organization agreements, with zero Stripe billing ever confirmed — violating
"PLAN SELECTED ≠ ACTIVE SUBSCRIPTION ≠ PAID ENTITLEMENT."

Audited for an existing field distinguishing "locally selected" from "provider-confirmed" before
adding anything new (per this phase's own instruction): `providerSubscriptionReference` is NOT
sufficient — `PlatformBillingWebhookService.syncCheckoutCompleted` syncs it even for a NOT-yet-eligible
checkout (P0-4). The one existing field that IS exactly "has Stripe genuinely confirmed this
organization active" is `business_profile.onboarding_step` reaching `"billing_setup_complete"` — set
ONLY by `PlatformBillingWebhookService.activateOnboardingIfNeeded`, itself only ever called once the
provider's own authoritative state is `"active"` (P0-4). No new column/migration was needed.

**Fix:** `EntitlementService` now takes a `BusinessProfileRepository` dependency and requires
`onboardingStep === "billing_setup_complete"` before consulting the subscription/entitlement catalog
at all, in both `entitled()` and `getEntitlementLimit()`. `BusinessActivationService` needed no change
— its aggregate `active` boolean was already correctly gated through the same onboarding-step fact;
only the narrower `EntitlementService` (a separate, pre-existing bypass) was fixed. `PricingService`/
`BusinessOnboardingService.selectTier` were deliberately left unchanged — the fix is at the
entitlement-consuming boundary, not the plan-selection or display layer, so "what plan did this
organization select" remains visible on the Billing page pre-confirmation exactly as before.

**Proof (adversarial, exercising the real production path — a locally "active" subscription row with
a fully-enabled catalog entitlement, with NO provider confirmation):**
```
npx vitest run src/lib/organizations/entitlementService.test.ts src/lib/organizations/agreementWorkspaceService.test.ts
```
New tests: `"P0-5: a plan merely SELECTED... grants NO paid entitlement before the organization's
billing is provider-confirmed"`, `"P0-5: the same organization becomes entitled the moment (and only
once) its billing reaches billing_setup_complete"`.

**Files touched:** `src/lib/organizations/entitlementService.ts` (new dependency + gate),
`src/lib/organizations/entitlementService.test.ts` (new adversarial tests; existing tests updated to
seed a provider-confirmed organization where entitlement is expected),
`src/lib/organizations/getEntitlementService.ts` (production factory wiring),
`src/lib/organizations/testFakes.ts` (`createTestEntitlementService` now accepts/shares a
`businessProfiles` fake; `createTestAgreementWorkspaceService` shares one instance across the
membership and entitlement sides — exactly one `business_profile` table exists in production),
`src/lib/organizations/agreementWorkspaceService.test.ts` and `src/app/api/agreements/route.test.ts`
(their shared `seedEntitledPlan` test helper now also marks the organization provider-confirmed),
`src/lib/organizations/agreementWorkspaceTenancy.postgres.test.ts` (real-Postgres construction site +
`seedEntitledPlan` helper updated identically), `scripts/productionUpgradeRehearsal.ts` (direct
compile/behavior dependency — the FROZEN P0-1 rehearsal's sentinel organization now seeds
`onboardingStep: "billing_setup_complete"` so its pre-existing "create a sentinel agreement" step
continues to exercise a genuinely-entitled organization, matching what that fixture always intended to
represent).

### RE-VERIFICATION UPDATE (2026-10-04, "FINAL SINGLE P0 DEFECT REMEDIATION")

Codex's independent re-verification found ONE remaining repository-controlled writer: `Business
OnboardingService.setUpBilling()` unconditionally advanced `onboardingStep` to `billing_setup_complete`
immediately after `PlatformBillingService.startSubscription()` returned — but `StartSubscriptionResult`
(and the Stripe SDK call behind it) carries only opaque references and billing-period dates, NO
authoritative status at all. A non-active Stripe subscription (trialing, incomplete, past_due,
canceled, etc.) created through this legacy, non-hosted-checkout billing entry point could therefore
still reach `billing_setup_complete` — the SAME marker `EntitlementService` (closed above) now trusts
as proof of provider-confirmed billing. The already-verified hosted-checkout/webhook path
(`PlatformBillingWebhookService.activateOnboardingIfNeeded`, gated on genuine `state.status === "active"`,
P0-4) was never the problem; this second, older writer was the one remaining bypass.

**Full audit of every production writer of `billing_setup_complete`** (Section 4 of the order):

| # | File | Function | Trigger | Provider status check? | Authorized? |
|---|---|---|---|---|---|
| 1 | `businessOnboardingService.ts` (pre-fix) | `setUpBilling()` | `startSubscription()` returns a reference | NO — never consulted | **NO — unsafe, this is the defect** |
| 2 | `platformBillingWebhookService.ts` | `activateOnboardingIfNeeded()`, called from `syncCheckoutCompleted`/`syncSubscriptionPeriod` | a verified Stripe webhook delivery | YES — `retrieveSubscriptionState().status === "active"` (P0-4) | YES — the one canonical writer |

No other production code path writes this value. (Test-only direct writers —
`businessProfiles.setOnboardingStep(...)` calls inside `*.test.ts` files and the `DrizzleBusinessProfileRepository.setOnboardingStep` method they call — are not production call graph entries; the method itself is a generic repository primitive with no caller outside tests and `PlatformBillingWebhookService`'s own helper, which already routes through `advanceBusinessOnboardingStepIfNeeded`.)

**Fix:** removed the unconditional `await this.advanceStep(profile.id, profile.onboardingStep,
"billing_setup_complete")` call from `BusinessOnboardingService.setUpBilling()` entirely. The method
still performs every other responsibility (attach payment method, start the subscription, persist
provider references, sync invoices, record `SUBSCRIPTION_STARTED`) — it simply no longer completes
onboarding itself. Because `PlatformBillingService.setUpBilling` already persists the provider
customer/subscription references onto the organization's row before returning, the real Stripe
`customer.subscription.created`/`.updated` webhook Stripe fires for this same subscription resolves
back to this organization exactly as a hosted-checkout-originated one would, and
`activateOnboardingIfNeeded` (P0-4, untouched) completes onboarding the moment — and only once — Stripe
confirms "active." Zero status-checking logic was duplicated; `mapStripeSubscriptionStatus`,
`isEligibleForActivation`, and both webhook entry points are byte-for-byte unchanged.

`billing_setup_complete` now has exactly ONE production writer and exactly ONE meaning across the
entire codebase: "Paid2You has authoritative evidence that the standard Stripe-backed Business
subscription is active."

**Proof (adversarial, exercising the real production path — `BusinessOnboardingService.setUpBilling`
→ `PlatformBillingService.setUpBilling` → provider `startSubscription`, with the provider's
authoritative status set independently afterward to prove it was never consulted):**
```
npx vitest run src/lib/organizations/businessOnboardingService.test.ts src/app/api/organizations/onboarding/onboardingSteps.route.test.ts
```
New tests (describe block `"P0-5 (Final remediation): setUpBilling cannot complete billing without a
provider-confirmed active subscription"`):
- `it.each(["active","trialing","payment_failed","past_due","canceled","suspended"])` — `setUpBilling`
  never advances `billing_setup_complete` on its own for ANY status, including "active" itself (only
  the webhook may, per the single-writer rule above).
- `"...grants zero paid entitlement and never activates the Business, with no activation audit
  recorded"` — exercises the real `EntitlementService`/`PricingService` pairing.
- `"P0-5 ACTIVE CASE: ... activates ... exactly once, with no duplicate on replay"` — builds a real
  `PlatformBillingWebhookService` over the SAME subscription/business-profile/audit fakes the
  onboarding harness used, delivers a signed `customer.subscription.updated` event reporting "active,"
  and proves onboarding completes with exactly one `PLATFORM_SUBSCRIPTION_ACTIVATED` audit event, with
  a replay of the identical event correctly reported as a duplicate and not double-audited.
- The route-level test in `onboardingSteps.route.test.ts` (renamed from its prior, now-incorrect title)
  proves the same invariant through the full HTTP handler stack.

Two pre-existing tests (`"Business is NOT activated merely because the onboarding form was
submitted..."` and `"correct activation when all domain requirements are satisfied..."`) were testing
verification/legal-acceptance independence, not billing completion itself; they now simulate the
provider-confirmed webhook having already landed via `businessProfiles.setOnboardingStep(...)` —
identical to this same file's own pre-existing "P0-5 (Codex): onboarding tier reentry" describe block's
established precedent for the same purpose — rather than relying on `setUpBilling`'s own (now-removed)
unconditional advance.

**Files touched:** `src/lib/organizations/businessOnboardingService.ts` (the fix),
`src/lib/organizations/businessOnboardingService.test.ts` (new adversarial matrix/active-case tests;
two pre-existing tests updated to simulate webhook confirmation directly),
`src/lib/organizations/platformBillingTestFakes.ts` (new exported
`InMemoryPlatformBillingWebhookEventRepository` — mirrors `platformBillingWebhookService.test.ts`'s own
identical, untouched, frozen private fake — so the active-case test can build a real
`PlatformBillingWebhookService` without duplicating webhook/claim logic),
`src/app/api/organizations/onboarding/onboardingSteps.route.test.ts` (route-level regression updated to
the corrected expectation). No change to `platformBillingService.ts`, `stripePlatformBillingProvider.ts`,
`platformBillingWebhookService.ts`, `platformBillingProvider.ts`, or `entitlementService.ts` — P0-4 and
the just-closed P0-5 entitlement gate are both byte-for-byte unchanged by this remediation. No schema
migration — none was needed; the fix is the removal of one unconditional method call.

## P0-6 — cancel/reactivate reported success when Stripe failed

**Root cause:** `PlatformBillingService.cancelAtPeriodEnd`/`reactivate` mutated LOCAL state and
recorded a success audit event FIRST, then called Stripe best-effort inside a `try { } catch { /* 
discarded */ }` — a Stripe failure was silently swallowed while the method still returned/audited
success.

**Fix:** reordered — the provider is called FIRST (when a real `providerSubscriptionReference`
exists); on failure, a typed `DependencyError` (503, pre-existing error class, reused rather than
inventing a new one) is thrown, local state is left completely unchanged, and no audit is recorded.
Local-only cancellation (no provider relationship exists yet) remains a safe, honest no-op-for-Stripe
path, since there is nothing to misrepresent.

**Proof:**
```
npx vitest run src/lib/organizations/platformBillingService.test.ts
```
Describe block `"P0-6 (Codex): cancel/reactivate are truthful about provider outcome"` — success
(local updated, exactly one audit) and failure (local UNCHANGED, zero audit, typed `DependencyError`
thrown) for both cancel and reactivate; a duplicate cancel request is deterministic; a no-subscription
organization is denied before any provider call is attempted.

## P0-7 — production-readiness false positive

**Root cause:** `scripts/check-production-readiness.mjs` never checked the 4 Stripe standard-plan
Price IDs, and accepted ANY non-empty `APP_URL` (including `http://localhost:3000`) as satisfying
`BUSINESS_PLATFORM`'s boot requirement — both silently absent from the computed readiness, so a
genuinely unusable configuration could read `BUSINESS_PLATFORM: READY`.

**Fix:** `stripeConfigured` now also requires `STRIPE_STARTER_PRICE_ID`/`STRIPE_CORE_PRICE_ID`/
`STRIPE_GROWTH_PRICE_ID`/`STRIPE_SCALE_PRICE_ID`; a new `isProductionShapedAppUrl` check (mirroring
`src/config/env.ts`'s own production `superRefine` hostname rule verbatim — `localhost`/`127.0.0.1`/
`::1` are all rejected) gates the boot-required check. The output vocabulary itself changed:
`BUSINESS_PLATFORM` now reads `CONFIGURATION_READY`/`CONFIGURATION_INCOMPLETE` (never the old bare
"READY", which Codex correctly read as overstating launch approval), and a new `LIVE_VERIFIED: "NO"`
field is always present (this script makes zero network calls, so it can never itself produce `YES`).

**Proof:**
```
node --test scripts/check-production-readiness.test.mjs
```
19/19 — individually covers: localhost APP_URL, 127.0.0.1, non-production APP_ENV, unparseable
APP_URL, each of the 4 missing Stripe prices individually, missing Stripe webhook secret (pre-existing
coverage), missing Resend, missing Supabase, and the fully-configured case
(`CONFIGURATION_READY` + `LIVE_VERIFIED: NO`). No secret value ever appears in the output (existing
coverage, re-verified).

**Docs updated:** `docs/PRODUCTION_LAUNCH_RUNBOOK.md` step 16 and `docs/OWNER_LAUNCH_ACTIONS.md`'s
`APP_ENV` row both now name `CONFIGURATION_READY`/`LIVE_VERIFIED` explicitly instead of the retired
bare "READY".

## Combined targeted regression command (all 7 items, non-Postgres)

```
npx vitest run \
  src/lib/organizations/businessVerificationWebhookService.test.ts \
  src/lib/organizations/platformBillingWebhookService.test.ts \
  src/app/api/webhooks/billing/stripe/route.test.ts \
  src/app/api/webhooks/business-verification/middesk/route.test.ts \
  src/lib/organizations/middeskBusinessVerificationProvider.test.ts \
  src/lib/organizations/platformBillingService.test.ts \
  src/lib/organizations/businessOnboardingService.test.ts \
  src/app/api/organizations/onboarding/onboardingSteps.route.test.ts \
  src/app/api/organizations/onboarding/billing/checkout/route.test.ts \
  src/app/api/organizations/billing/billingActions.route.test.ts
```
114/114 passed.

## Full validation ladder run this phase

```
npx tsc --noEmit                         # clean, 0 errors
npx eslint .                             # 0 errors, 35 pre-existing warnings (unchanged)
npm run build                            # succeeds
<combined targeted command above>        # 114/114
npm run db:upgrade-rehearsal             # PASS (Item F mechanics, unchanged)
npm run db:upgrade-orchestrator-rehearsal  # PASS (P0-1's new orchestrator command, end to end)
node --test scripts/check-production-readiness.test.mjs   # 19/19 (P0-7)
npm run check-no-sandbox-runtime         # OK — 902 files (Adyen retirement static check)
npx vitest run --exclude '**/*.postgres.test.ts'
                                          # 2918/2919 — the SAME single accepted baseline failure,
                                          #   zero new failures (was 2891/2892 before this phase —
                                          #   +27 net new passing tests)
npm run test:postgres                    # 342/342 passed, 15 files (was 337/14 — +5 new:
                                          #   webhookEventClaim.postgres.test.ts) — this run is also
                                          #   the fresh-migration-chain proof
```

## Repository-controlled P0 status after this phase

All 7 Codex-found defects (P0-1 through P0-7) are closed, reproduced-then-fixed-then-tested, with zero
regressions to any previously-accepted behavior. Combined with the 9 items (A-I) closed in the two
phases above, no repository-controlled P0 item remains open from either verification pass.
External/owner-controlled items remain exactly as listed earlier in this document (live Stripe/Middesk
credential exercise; the 3 NOT-IMPLEMENTED email categories; owner/counsel legal sign-off) — none of
the 7 Codex defects changed that list.

# SURGICAL FINAL P0 REMEDIATION (2026-10-04, same-day continuation)

Codex's INDEPENDENT RE-VERIFICATION of the phase above found exactly THREE of the seven not fully
closed: P0-2, P0-4, P0-5 (each documented in its own "RE-VERIFICATION UPDATE" subsection above, in
place). P0-1/P0-3/P0-6/P0-7 were re-confirmed via regression only — not modified.

## Combined targeted regression command (the 3 re-opened items, non-Postgres)

```
npx vitest run \
  src/lib/organizations/middeskBusinessVerificationProvider.test.ts \
  src/lib/organizations/stripePlatformBillingProvider.test.ts \
  src/lib/organizations/platformBillingWebhookService.test.ts \
  src/lib/organizations/entitlementService.test.ts \
  src/lib/organizations/agreementWorkspaceService.test.ts \
  src/app/api/agreements/route.test.ts
```
99/99 passed.

## Full validation ladder run this phase

```
npx tsc --noEmit                         # clean, 0 errors
npx eslint <every file touched this phase>  # 0 errors
npm run build                            # succeeds
<combined targeted command above>        # 99/99
npx vitest run --exclude '**/*.postgres.test.ts'
                                          # 2925/2926 — the SAME single accepted baseline failure
                                          #   (AgreementCreateWizard.test.tsx, line 249), zero new
                                          #   failures (was 2921/2926 before this phase's fixture
                                          #   fixes landed, purely from new P0-5 test cases added)
npm run test:postgres                    # 342/342 passed, 15 files — includes
                                          #   agreementWorkspaceTenancy.postgres.test.ts (5/5, updated
                                          #   construction site + seeding helper) and
                                          #   webhookEventClaim.postgres.test.ts (5/5, P0-3 regression,
                                          #   untouched)
npm run db:upgrade-orchestrator-rehearsal  # PASS, end to end — including the FROZEN P0-1 rehearsal's
                                          #   own "create a sentinel agreement" step, which now
                                          #   exercises a genuinely provider-confirmed organization
                                          #   under the new P0-5 EntitlementService gate
node --test scripts/check-production-readiness.test.mjs   # 19/19 (P0-7, untouched)
```

## Files touched this phase (complete list)

- `src/lib/organizations/middeskBusinessVerificationProvider.ts` — P0-2 fix
- `src/lib/organizations/middeskBusinessVerificationProvider.test.ts` — P0-2 adversarial tests
- `src/lib/organizations/platformBillingProvider.ts` — P0-4 fix (new `"trialing"` status value)
- `src/lib/organizations/stripePlatformBillingProvider.ts` — P0-4 fix (mapping)
- `src/lib/organizations/stripePlatformBillingProvider.test.ts` — P0-4 adversarial test + corrected
  pre-existing assertion
- `src/lib/organizations/platformBillingWebhookService.test.ts` — P0-4 adversarial tests (both
  activation entry points)
- `src/lib/organizations/entitlementService.ts` — P0-5 fix (new gate)
- `src/lib/organizations/entitlementService.test.ts` — P0-5 adversarial tests + updated fixtures
- `src/lib/organizations/getEntitlementService.ts` — P0-5 production factory wiring
  (direct-compile-dependency)
- `src/lib/organizations/testFakes.ts` — P0-5 fixture wiring (direct-compile-dependency)
- `src/lib/organizations/agreementWorkspaceService.test.ts` — P0-5 fixture update
  (direct-compile-dependency)
- `src/lib/organizations/agreementWorkspaceTenancy.postgres.test.ts` — P0-5 fixture + construction-site
  update (direct-compile-dependency)
- `src/app/api/agreements/route.test.ts` — P0-5 fixture update (direct-compile-dependency)
- `scripts/productionUpgradeRehearsal.ts` — P0-5 direct-compile/behavior-dependency (FROZEN P0-1
  rehearsal script; one organization's seed data now reaches `billing_setup_complete`, matching what
  that fixture always intended to represent)

No file outside this list was modified this phase. No P0-1/P0-3/P0-6/P0-7 code was touched — only their
existing regression suites were re-run to prove no behavior changed.
