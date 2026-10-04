# Production Financial Provider Readiness

**Path:** `docs/PRODUCTION_PROVIDER_READINESS.md`

> ## ⚠ PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED
>
> **Adyen is retired from the Paid2You architecture.** It may not be implemented, configured,
> enabled, recommended, restored, used as a fallback, or routed through under any circumstance
> without explicit written authorization from the Paid2You owner. Every reference to Adyen in the
> rest of this document below is **historical record of a now-retired direction**, not the current
> or future production direction — `PROVIDER_CAPABILITY_REGISTRY`
> (`src/lib/providers/providerCapabilities.ts`) is empty again; `getPaymentProvider()` throws
> `ProviderNotAvailableError` for `PAYMENT_PROVIDER=adyen` (or any other value) in every environment.
> `AdyenPaymentProvider` and its surrounding adapter/webhook code remain in the repository as
> retired/legacy material — never deleted outright by this directive alone — but are structurally
> unreachable from any production code path.
>
> **The owner-approved direction going forward:**
> - Repayment money movement (customer-to-customer, the actual agreement/arrangement rail): **Direct
>   Banking Connectivity** — FedNow, RTP, and Request for Payment. Not yet implemented (Phase 3B).
> - Paid2You's own subscription billing (a separate domain from the above): **Stripe Billing**. Not
>   yet implemented (Phase 3A).
> - Business verification: **Middesk**. Not yet implemented (Phase 3A).
> - Transactional email: **Resend** (already implemented, production-fail-closed — unaffected).
> - Agreement/document storage: **Supabase Storage** (already implemented, production-fail-closed —
>   unaffected).
> - SMS: deferred unless explicitly authorized for launch.
>
> Naming a vendor above is not itself an implementation directive — each requires its own explicit,
> detailed kickoff before any adapter code, environment variable, or registry entry is created for it.

PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md) requires "an
architecture decision record documenting required capabilities, the abstraction layer, assumptions,
unresolved provider selection, integration points, and migration/replacement strategy" whenever no
production provider has yet been definitively selected — which is this project's current, actual
state. This document is that record, plus the per-provider checklist SPRINT_18C_PRODUCTION_READY.md
item 152 requires ("Production provider readiness should have its own checklist"). **Everything below
this point describes the since-retired Adyen-based direction — read it as history, not as the plan.**

## 1. Current state (as of this writing)

**No live financial provider account, contract, or approval exists, and — as of the 2026-09-15 B0-D
TOTAL SANDBOX ELIMINATION remediation — sandbox/mock provider implementations are no longer reachable
from application runtime at all.** The 2026-09-15 B0-D production-gate audit found that every
financial/KYC/card-issuing operation in production ran against sandbox providers with no disclosure to
customers, and that `assertProviderEnvironmentConsistency`'s prior design explicitly *permitted*
sandbox-in-production rather than blocking it — the release blocker this remediation exists to close.

**What changed:** `PROVIDER_CAPABILITY_REGISTRY` (`src/lib/providers/providerCapabilities.ts`) no
longer contains sandbox descriptors at all — but it is **not empty**: `adyen` is registered as a
`environment: "production"` descriptor for `ach_debit`/`webhook_delivery`/`bank_linking` (B0-D ADYEN
PHASE 1/2, code-complete). **Registration is not operational readiness** — it means the adapter exists
and is wired to construct if selected, never that Adyen has approved this merchant account or that
live credentials exist (neither is true as of this writing). Nothing is registered for KYC/KYB or
card issuing — `getKycProvider()`/`getCardIssuingProvider()` still throw unconditionally for every
input, no vendor has been selected for either. `getPaymentProvider()`/`getKycProvider()`/
`getCardIssuingProvider()` (`src/lib/payments`, `src/lib/kyc`, `src/lib/cards`) no longer import or
construct `SandboxPaymentProvider`/`SandboxKycProvider`/`SandboxCardIssuingProvider` — those classes
were relocated to `src/test-support/` and exist only as constructor-injected test doubles (see
`src/lib/payments/testFakes.ts` and its KYC/cards siblings), never reachable from any route, page, or
other production runtime module. `getKycProvider()`/`getCardIssuingProvider()` throw
`ProviderNotAvailableError` (503) unconditionally — there is no sandbox fallback branch to fall into.
`getPaymentProvider()` throws the same way for any name other than `"adyen"`; for `"adyen"` itself it
throws `ConfigurationError` unless `ADYEN_API_KEY`/`ADYEN_MERCHANT_ACCOUNT`/`ADYEN_LIVE_PREFIX`/
`ADYEN_PAYMENTS_HMAC_KEY` are all genuinely configured (none are, today) — equally fail-closed, by
credential absence rather than by an unregistered name. On top of that, **new** payment initiation
specifically (`PaymentService.createPayment`; `AchPaymentService`/`DebitCardPaymentService`
`.submitScheduledPayment`; `AchPaymentService`/`DebitCardPaymentService.createManualPayment`'s
genuinely-new-attempt branch, reached by the manual-payment routes and by
`PaymentRetryService.fireDueRetries`'s non-production fallback branch; and, for the real
production automatic-retry path, `PaymentRetryService.fireDueRetries`'s atomic-coordinator branch via
`DrizzlePaymentInitiationEligibilityService.assertPreLockEligible`) additionally requires
`ADYEN_PAYMENTS_VERIFIED=true` (B0-D C2, defaults `false`) — an operator-only confirmation that
registration/credentials alone can never substitute for; see that env var's own doc comment in
`src/config/env.ts`. **Resume-B0-D-C2 correction (this pass):** an earlier version of this gate left
`createManualPayment`'s genuinely-new-attempt branch and the automatic-retry dispatch path unguarded —
both have now been closed; only genuine idempotent replay of an attempt with persisted evidence of
prior provider submission (a payment_attempt already past `"scheduled"`) and ambiguous-retry
*resolution* (`resolveAmbiguousRetry`, which never calls `provider.createPayment` again) remain exempt,
matching webhooks/refunds/reconciliation, which this gate never touches. Because every payment/KYC/card-issuing
route and webhook constructs its service through exactly these three factories (directly or
transitively via `getPaymentService`/`getBankConnectionService`/`getAchPaymentService`/
`getKycVerificationService`/`getCardService`/etc.), every one of those routes fails closed — by one of
these three independent mechanisms — before any real financial mutation, ledger mutation, or lifecycle
transition reaches Adyen. The customer-facing bank-connection flow (`/payment-methods/add-bank`)
remains additionally gated by `ADYEN_ACH_TOKENIZATION_VERIFIED` (defaults `false`, unrelated Adyen
capability); the admin sandbox-settlement-simulation endpoint
(`/api/admin/sandbox/simulate-settlement`, now deleted) no longer exists/executes. `PAYMENT_PROVIDER`/
`KYC_PROVIDER`/`CARD_ISSUING_PROVIDER` (`src/config/env.ts`) reject any sandbox/mock/fake/demo/dummy/
stub/simulated/test-shaped value outright at environment-parse time — a CI regression gate
(`scripts/check-no-sandbox-runtime.mjs`, run on every push/PR) fails the build if sandbox provider
functionality is ever reintroduced into application runtime source, and remains unaffected by any of
the above: **sandbox runtime stays permanently disabled regardless of what is or isn't registered for
a live provider.**

**Status: `EXTERNAL BLOCKER — LIVE FINANCIAL PROVIDER APPROVAL/CONFIGURATION REQUIRED`**, per
SPRINT_18C_PRODUCTION_READY.md item 26's exact required label — **unchanged**: this remediation makes
the *absence* of a live, *approved* provider fail closed instead of silently substituting sandbox
behavior, it does not resolve the underlying blocker (a live provider still has not been
contracted/approved, regardless of what is registered in code). B-1 (live provider integration)
remains on hard hold. This blocker is not resolved by any Phase 6 PRSprint — Phase 6's explicit scope
is architecture, not live activation (see the phase kickoff's own "CRITICAL SAFETY BOUNDARY").

## 2. Required capabilities

Derived from this codebase's actual, already-implemented domain needs — see
`src/lib/providers/providerCapabilities.ts` for the canonical, machine-checked list:

| Capability | Needed for | Currently exercised by |
|---|---|---|
| `kyc` | Individual identity verification before full financial capability | `VerificationService`, `KycVerificationService` |
| `kyb` | Business identity verification | Same, `profileKind: "business"` |
| `bank_linking` | Connecting an external bank account for ACH | `AchMandateService`, `financial_account` (Sprint 18A) |
| `ach_debit` | Pulling an installment payment from a debtor's linked bank account | `AchPaymentService` |
| `ach_credit` | Paying out cleared funds to a creditor's linked bank account | `LedgerService.postPayout` |
| `virtual_account_creation` | A dedicated per-agreement or platform-level clearing account, if the eventual provider requires one (not required by the current sandbox architecture, which uses an internal shadow ledger instead — see `docs/PAYMENT_ARCHITECTURE.md` §14) | Not yet exercised — assess once a provider is selected |
| `debit_card_issuing` | Issuing a PAY2PAY-branded card to a creditor so they can spend received funds | New in PRSprint 24 — `CardService` |
| `webhook_delivery` | Asynchronous status updates for all of the above | `PaymentWebhookService`, `KycWebhookService`, and PRSprint 24's card webhook |
| `transaction_reconciliation` | Detecting drift between provider state and this codebase's own ledger | `ReconciliationService` (Phase 5) |

## 3. Abstraction layer

Every capability above is reached exclusively through a stable, provider-agnostic interface — never a
vendor SDK call scattered through business logic or UI (SPRINT_18C item 150's exact requirement):

- `PaymentProvider` (`src/lib/payments/paymentProvider.ts`) — ACH/card charging, payouts, refunds.
- `KycKybProvider` (`src/lib/kyc/kycProvider.ts`) — individual/business identity verification.
- `CardIssuingProvider` (`src/lib/cards/cardIssuingProvider.ts`, PRSprint 24) — card issuance/lifecycle.

`PaymentProvider` has one registered implementation today (`AdyenPaymentProvider`, `environment:
"production"`, gated by credentials plus `ADYEN_PAYMENTS_VERIFIED` — see §1); `KycKybProvider` and
`CardIssuingProvider` have none — no vendor has been selected for either. Selection happens via an env
var (`PAYMENT_PROVIDER`, `KYC_PROVIDER`, `CARD_ISSUING_PROVIDER`) resolved through the capability
registry in `src/lib/providers/providerCapabilities.ts`. Adding a real provider is additive at every
layer: a new class implementing the same interface, a new registry entry declaring its capabilities and
`environment: "production"`, a new enum value on the relevant env var — **zero changes to
`PaymentService`, `KycVerificationService`, `RelationshipFinancialAccountService`, `CardService`, or any
route/UI that consumes them.**

## 4. Environment separation

`assertProviderAvailableForRuntime` (`providerCapabilities.ts`) — renamed and rewritten by the B0-D
TOTAL SANDBOX ELIMINATION remediation, superseding the prior `assertProviderEnvironmentConsistency` —
structurally allows exactly two outcomes, never a third: (1) a registered, `environment:
"production"`-tagged provider, constructed only when `APP_ENV === "production"` — a real credential
can never be silently exercised from a preview/staging/development deployment; or (2) anything else
(nothing registered, an unknown name, a sandbox/mock name, or the env var left unset) throws
`ProviderNotAvailableError`. Unlike the prior design, sandbox-in-production is no longer a permitted,
labeled exception — it is structurally impossible, because no sandbox descriptor is registered at all.

## 5. Per-provider go-live checklist (for whichever provider(s) are eventually selected)

For each of Payments, KYC/KYB, and Card Issuing, before flipping its env var away from `"sandbox"`:

- [ ] Contract/account approved by the provider and by PAY2PAY's compliance/legal function.
- [ ] Production API credentials issued and stored only as Vercel environment variables (never in Git,
      never client-exposed) — see `src/config/env.ts`'s existing "server-only, optional-until-used"
      pattern every provider secret in this codebase already follows.
- [ ] Production webhook endpoint registered with the provider, and its signature-verification secret
      configured — mirroring `PaymentWebhookService`/`KycWebhookService`'s already-hardened signature +
      replay-protection pattern (Phase 5 PRSprint 20).
- [ ] Sender/domain/business identity verified with the provider where applicable.
- [ ] Documented production rate limits/quotas and confirmed this codebase's own request volume stays
      within them.
- [ ] A new class implementing the relevant interface (`PaymentProvider`/`KycKybProvider`/
      `CardIssuingProvider`) exists, is unit-tested, and is registered in
      `providerCapabilities.ts` with `environment: "production"` and an accurate capability list.
- [ ] The relevant env var (`PAYMENT_PROVIDER`/`KYC_PROVIDER`/`CARD_ISSUING_PROVIDER`) enum in
      `src/config/env.ts` includes the new provider's name.
- [ ] `liveBankingEnabled`/`liveCardIssuanceEnabled` (`src/lib/feature-flags.ts`) flipped on only after
      the above are all true, and only in the environment(s) actually ready.
- [ ] A controlled, low-value live transaction/verification has been run end-to-end and reconciled,
      mirroring this project's established "controlled production verification" precedent from
      PRSprints 14/15 (email/SMS go-live).
- [ ] `docs/prsprints/PRSPRINT_CONTROL.md`'s relevant row's `EXTERNAL BLOCKER` column is updated from
      `YES` to `NONE` only once every item above is genuinely true — never based on sandbox behavior
      alone (this document's own §1, restated).

## 6. Assumptions

- The current internal shadow-ledger architecture (Phase 5, `docs/PAYMENT_ARCHITECTURE.md` §14) is
  assumed to remain the balance source of truth regardless of which provider is eventually selected —
  the provider is authoritative for facts that occurred inside its own infrastructure (a transfer
  settled, a card cleared), never for PAY2PAY's own domain state (obligations, schedules, ledger,
  agreement status) per this phase's own "Provider → PAY2PAY source-of-truth rule."
- No specific provider (Stripe, Plaid, Marqeta, Persona, Onfido, or any other) has been evaluated or
  selected as of this writing. Selecting one is an explicit Product Owner decision requiring commercial,
  compliance, and legal input this document does not attempt to make.

## 7. Migration/replacement strategy

Because every consumer depends only on the stable interfaces in §3, replacing one provider with another
(or adding a second provider for a capability the first doesn't support — "do not assume every future
provider supports every capability") requires no change outside: the new provider class, its
`providerCapabilities.ts` registry entry, and its env-var enum value. Existing data is unaffected —
`ach_mandate.bank_account_ref`/`debit_card_method.card_token`/`financial_account.provider_account_ref`/
`identity_verification_record.provider_ref` are already opaque, provider-name-tagged references, never
assumed to come from one specific vendor's ID format.
