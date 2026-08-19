# Production Financial Provider Readiness

**Path:** `docs/PRODUCTION_PROVIDER_READINESS.md`

PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md) requires "an
architecture decision record documenting required capabilities, the abstraction layer, assumptions,
unresolved provider selection, integration points, and migration/replacement strategy" whenever no
production provider has yet been definitively selected — which is this project's current, actual
state. This document is that record, plus the per-provider checklist SPRINT_18C_PRODUCTION_READY.md
item 152 requires ("Production provider readiness should have its own checklist").

## 1. Current state (as of this writing)

**No live financial provider has been selected or contracted.** Every financial-provider integration
in this codebase — payments (ACH/card charging) and KYC/KYB — runs exclusively against sandbox/mock
implementations (`SandboxPaymentProvider`, `SandboxKycProvider`). This is visible at runtime via
`GET /api/admin/overview`'s `environmentStatus.paymentProviderEnvironment`/`kycProviderEnvironment`
fields (both `"sandbox"` today) and in the Admin Dashboard UI, which labels this explicitly rather than
implying live capability.

**Status: `EXTERNAL BLOCKER — LIVE FINANCIAL PROVIDER APPROVAL/CONFIGURATION REQUIRED`**, per
SPRINT_18C_PRODUCTION_READY.md item 26's exact required label. This blocker is not resolved by any
Phase 6 PRSprint — Phase 6's explicit scope is architecture, not live activation (see the phase
kickoff's own "CRITICAL SAFETY BOUNDARY").

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

Each interface has exactly one registered implementation today (its sandbox mock), selected via an env
var (`PAYMENT_PROVIDER`, `KYC_PROVIDER`, `CARD_ISSUING_PROVIDER`) resolved through the capability
registry in `src/lib/providers/providerCapabilities.ts`. Adding a real provider is additive at every
layer: a new class implementing the same interface, a new registry entry declaring its capabilities and
`environment: "production"`, a new enum value on the relevant env var — **zero changes to
`PaymentService`, `KycVerificationService`, `RelationshipFinancialAccountService`, `CardService`, or any
route/UI that consumes them.**

## 4. Environment separation

`assertProviderEnvironmentConsistency` (`providerCapabilities.ts`) structurally prevents a
`environment: "production"`-tagged provider from ever being constructed outside `APP_ENV ===
"production"` — a real credential can never be silently exercised from a preview/staging/development
deployment. The reverse (sandbox running inside production, today's actual state) is explicitly
permitted and clearly labeled, not blocked, matching the Hard Stop rule ("mark it EXTERNAL BLOCKER,
never represent it as live") rather than treating sandbox-in-production as an error condition.

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
