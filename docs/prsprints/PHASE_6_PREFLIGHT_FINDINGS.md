# Phase 6 Pre-Flight Findings — PRSprints 21-24 (Financial Providers)

**Date:** 2026-08-19
**Scope:** Read-only audit performed before any Phase 6 implementation, per the phase kickoff's mandatory
pre-phase configuration check and "read all four specs before implementation" instruction.

## 0. Pre-phase configuration check — `PAYMENT_SANDBOX_WEBHOOK_SECRET`

Per the phase kickoff's explicit instruction, this was checked and resolved before any other work:

1. **Missing?** Confirmed missing from all three Vercel environments (production, preview, development)
   via `vercel env ls`.
2. **Do the sandbox payment routes require it?** Yes — `getPaymentProvider()` constructs
   `SandboxPaymentProvider` with this value and throws `ConfigurationError` if absent; every
   `/api/payments/*` route builds its handler (and therefore calls `getPaymentProvider()`) before
   `requireSession` even runs, so every payment route — authenticated or not — was failing.
3. **Safe to configure?** Yes. Traced in `src/config/env.ts`'s own doc comment: "HMAC secrets for the
   sandbox/mock payment... provider webhook signatures" — this is an entirely internal, self-referential
   secret the sandbox mock uses to sign and verify *its own* simulated webhooks. It is never sent to,
   or received from, any real external party, grants no external access, and moves no real money.
4. **Does configuring it change production behavior?** Yes, in the intended way: it makes the entire
   `/api/payments/*` domain functional again (previously 100% broken with `CONFIGURATION_ERROR`,
   regardless of authentication). No other behavior changes.
5. **Internal sandbox secret or provider-issued credential?** Internal sandbox secret — confirmed via
   `SandboxPaymentProvider`'s own doc comment ("NOT a real Stripe/Plaid sandbox integration... nothing
   here ever reaches a real network or moves real money").

**Action taken:** generated a new 256-bit random secret (`crypto.randomBytes(32).toString("base64")`)
and added it via `vercel env add PAYMENT_SANDBOX_WEBHOOK_SECRET` to Production and Development (this
phase's own kickoff explicitly authorized generating/configuring exactly this kind of internal sandbox
secret). **Not committed to Git** — set only via the Vercel CLI, encrypted at rest by Vercel. Redeployed
production; verified `/api/payments/detail` and `/api/payments/create` (both pre-existing, unrelated to
Phase 5/6) now correctly return `401 UNAUTHENTICATED` instead of `500 CONFIGURATION_ERROR`.

**Known residual gap, not silently hidden:** the identical `vercel env add ... preview --value ... --yes`
command (the CLI's own documented non-interactive syntax) consistently fails with a
`git_branch_required` error for the "all Preview branches" case in this Vercel CLI version (52.0.0) —
appears to be a CLI bug, not a usage error (multiple documented invocation forms were tried). Preview
deployments therefore still lack this variable; PR CI has passed without it throughout this project's
history since CI never exercises a real payment route end-to-end. Not blocking; flagged for a manual
fix (e.g., via the Vercel dashboard) rather than left unexplained.

**Same reasoning applies to `KYC_SANDBOX_WEBHOOK_SECRET`** (PRSprint 22's dependency, identical pattern,
also confirmed missing from all three environments) — resolved the same way at the start of PRSprint 22
below, not here, to keep this section scoped to the phase kickoff's specific named check.

## 1. Existing architecture — this phase is overwhelmingly an audit-and-harden phase, not a from-scratch
## build, with one major exception (PRSprint 24)

Reading the existing codebase before writing any code (per Mandatory Execution Rule 4 in every PRSprint
doc) found a substantially more mature financial-provider architecture already in place than a
from-scratch Phase 6 would assume:

### PRSprint 21 (Provider Architecture) — mostly already satisfied
- `PaymentProvider` (`src/lib/payments/paymentProvider.ts`, Sprint 9) and `KycKybProvider`
  (`src/lib/kyc/kycProvider.ts`, Sprint 9) are both already clean, stable, provider-agnostic interfaces
  — `SandboxPaymentProvider`/`SandboxKycProvider` are the only implementations, but every consumer
  (`PaymentService`, `AchPaymentService`, `DebitCardPaymentService`, `KycVerificationService`) depends
  only on the interface, never a concrete provider class. This already satisfies "PaymentService/
  FinancialAccountService/IdentityVerificationService" existing as stable service boundaries — those
  four class names from the PRSprint's own required list already exist nearly verbatim
  (`PaymentService`, `RelationshipFinancialAccountService`, `KycVerificationService`; `CardService` is
  the one that doesn't exist yet — see PRSprint 24).
- Provider IDs are already mappings, never primary keys: `ach_mandate.bank_account_ref`,
  `debit_card_method.card_token`, `financial_account.provider_account_ref`,
  `identity_verification_record.provider_ref`, `payment_attempt.provider_payment_id` are all opaque
  external references on tables keyed by the app's own UUIDs — confirmed by direct schema read.
- Webhook safety (signature verification → replay/duplicate-event protection → idempotent processing)
  is already implemented identically for both payments (`PaymentWebhookService`) and KYC
  (`KycWebhookService`), and was independently hardened for concurrent-race safety in Phase 5
  (PRSprint 20).
- `src/lib/feature-flags.ts` already exists (env-override-capable flag registry) but currently has only
  one placeholder flag — real flags for gating unavailable live financial capability need to be added.
- **Gap:** no formal, single "provider capability model" registry exists (which provider supports which
  capability) — implicit in which service classes exist, not explicit. No environment-separation
  *verification* exists (schema allows it; nothing tests/asserts sandbox credentials can't reach
  production). No secret-redaction test exists for the payment/KYC provider secrets specifically. No
  "production provider readiness checklist" doc exists.

### PRSprint 22 (KYC/KYB/Financial Account Provisioning) — mostly already satisfied
- `VerificationService` (Sprint 3, hardened Sprint 9) already implements a structurally
  non-self-reportable state machine (`UNVERIFIED → BASIC → FULL_PENDING → FULL_VERIFIED|FULL_REJECTED`)
  with full audit trail, a provider-driven decision path completely separate from the manual/admin path,
  and correctly generalized across `personal`/`business` (KYC and KYB share one state machine,
  distinguished only by `profileKind` — already satisfies "KYB must be distinct from KYC" at the data
  level while reusing the same audited mechanics, not duplicating them).
- `RelationshipFinancialAccountService` (Sprint 18A) already implements the full provisioning workflow
  requirement's five distinguished concepts almost verbatim: application user → Paid2You financial
  profile (`personalProfile`/`businessProfile`, pre-existing) → provider customer (implicit in
  `providerAccountRef`) → verified customer (`identity_verification_record`) → financial account
  (`financial_account`, its own `pending_verification|verified|failed|disabled` lifecycle) → linked
  external bank account/card (`ach_mandate`/`debit_card_method`, agreement-scoped, correctly separate
  concepts from the party-owned `financial_account`).
- No admin route exists that can set KYC/KYB to "verified" directly — the one admin verification route
  (`GET /api/admin/review/verification`) is read-only; `VerificationService.recordManualVerificationDecision`
  (the only method capable of a manual decision) has no HTTP route calling it at all, by original Sprint
  3 design ("exposing it publicly requires an admin-role/authorization system... building the endpoint
  without that authorization would create a real 'anyone can self-verify' hole"). This already
  structurally satisfies "admin override must be narrowly scoped... incapable of fabricating provider
  verification" — there is no override surface to narrow.
- **Gap:** the specific negative-test scenarios PRSprint 22 requires (cross-user KYC access, client
  self-setting verified status, malformed/duplicate/out-of-order provider callback, unauthorized/
  duplicate financial account provisioning) are only partially covered by existing tests — need
  targeted additions, not new architecture.

### PRSprint 23 (ACH/Bank Linking/Reconciliation) — mostly already satisfied
- `AchMandateService`/`AchPaymentService` (Sprint 11) are thin, correctly-scoped orchestration on top of
  the exact same `PaymentService`/`PaymentWebhookService`/`LedgerService`/`ReconciliationService`
  infrastructure Phase 5 hardened — ACH payments are `payment_attempt` rows with `payment_method =
  "ach"`, so they already inherit every Phase 5 guarantee (idempotency, atomic race-safety, reversal-
  preserves-history, reconciliation exception detection) for free, with zero ACH-specific gap in that
  layer.
- ACH lifecycle states already fully modeled: `scheduled → submitted → processing → succeeded |
  failed | returned | reversed`, matching item 105's exact required list, already exercised by Phase 5's
  own webhook/reconciliation tests generically (not ACH-labeled, but the same code path).
- Bank linking already uses provider-supplied tokens only (`bank_account_ref`) — never a raw account/
  routing number or online-banking credential; confirmed by schema read.
- **Gap:** no ACH-*specific* reconciliation test exists (the generic payment-reconciliation tests never
  set `paymentMethod: "ach"` explicitly); no admin view surfaces ACH mandate/provider references for
  support troubleshooting (item 109) — `AdminLedger.tsx` (Phase 5-era) shows payment/ledger data but not
  the ACH mandate layer specifically.

### PRSprint 24 (Debit Card Issuance & Card Lifecycle) — the one genuine from-scratch build
- The existing `debit_card_method`/`DebitCardPaymentService` (Sprint 12) is a **card-on-file-for-
  charging** model — a debit card the *debtor* registers so PAY2PAY can pull payments from it. This is
  a completely different concept from PRSprint 24's actual scope: **issuing** a PAY2PAY-branded debit
  card *to* a creditor/recipient so they can spend funds they've received. Confirmed by the source
  requirement's own text (SPRINT_18C_PRODUCTION_READY.md item 30, verbatim): "The audit found
  card-on-file functionality but not actual card issuance." Card issuance genuinely does not exist
  anywhere in this codebase yet — no schema, no service, no provider capability, no routes, no UI.
- This is the one PRSprint in this phase requiring real, substantial new architecture, matching the
  same rigor as the rest of the existing codebase (append-only lifecycle history, provider-token-only,
  never CVV/PIN/full-PAN, idempotent/audited actions, authorization mirroring the established
  `AchMandateService`/`DebitCardMethodService` shape).

## 2. Non-negotiable rules re-confirmed against existing code

- No raw bank credentials, CVV, PIN, or full PAN are stored anywhere in the existing schema — confirmed
  by reading every relevant table (`ach_mandate`, `debit_card_method`, `financial_account`,
  `identity_verification_record`). Phase 6 must preserve this and extend it identically to any new card-
  issuance schema.
- Provider webhook safety (signature → replay protection → idempotent apply) is already the established
  pattern for both payments and KYC; any new webhook (card issuance) must follow it exactly, including
  Phase 5 PRSprint 20's insert-then-recheck-on-conflict hardening.
- The Phase 5 ledger/balance architecture is authoritative and structurally isolated from provider
  webhooks writing anything except through `LedgerService`'s own idempotent posting methods — Phase 6
  must not introduce a second money-movement path that bypasses it.

## 3. Execution order for this phase (per the kickoff's pass-gate requirement)

21 (provider capability model, environment separation, feature-gating, secret redaction) -> verify ->
22 (KYC_SANDBOX_WEBHOOK_SECRET fix, targeted negative tests, provisioning-gate verification) -> verify ->
23 (ACH-specific reconciliation tests, admin ACH visibility) -> verify -> 24 (new card-issuance
architecture: schema, service, sandbox provider, routes, UI, tests) -> full Phase 6 verification.
