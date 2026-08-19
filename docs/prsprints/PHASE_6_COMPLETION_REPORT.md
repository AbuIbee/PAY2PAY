# Phase 6 Completion Report — PRSprints 21-24 (Production Financial Provider Architecture)

**Date:** 2026-08-19
**Branch:** `phase-6-financial-providers` (merged to `master` via PR #46, merge commit)
**Commits:** `d9dbc1e` (PRSprint 21) → `0bb7dc4` (PRSprint 22) → `6da30e1` (PRSprint 23) →
`0c6ffe6` (PRSprint 24), merged at `ee367e4`.
**Pre-flight findings:** `docs/prsprints/PHASE_6_PREFLIGHT_FINDINGS.md`
**Production Provider Decision Record (ADR):** `docs/PRODUCTION_PROVIDER_READINESS.md`

Status values used below follow `docs/prsprints/PRSPRINT_CONTROL.md`'s allowed set:
`PASS`, `FAIL`, `BLOCKED`, `NOT APPLICABLE`.

## 1. Phase result

**PASS.** All four PRSprints implemented, verified, and merged to `master`. The PRSprint 24 Supabase
migration was applied to the linked production project. Production Vercel deployment was auto-triggered
from the merge and verified live. **No live financial infrastructure was activated at any point** — see
§39 (Live Money Movement, matrix row AB) and §41 (Security Review) below.

## 2. PRSprint 21 result — Production Financial Provider Architecture

**PASS.** Established `ProviderCapabilityDescriptor`/`PROVIDER_CAPABILITY_REGISTRY`/
`assertProviderEnvironmentConsistency` (`src/lib/providers/providerCapabilities.ts`) — a
one-directional environment-separation guarantee: a `production`-tagged provider can never be
constructed outside `APP_ENV === "production"`; the reverse (sandbox running in a production
environment, today's real state) is explicitly permitted, matching the "mark EXTERNAL BLOCKER, never
represent sandbox as live" rule. New `PAYMENT_PROVIDER`/`KYC_PROVIDER` runtime switches
(`z.enum(["sandbox"]).default("sandbox")`). `getPaymentProvider`/`getKycProvider` rewritten to resolve
through the registry. Admin environment-status view (`AdminDashboard.tsx`) updated to show explicit
"(LIVE — real money moves)" vs "(sandbox — no real money moves)" copy. New `liveBankingEnabled`/
`liveCardIssuanceEnabled` feature flags, both `false`. New ADR (`docs/PRODUCTION_PROVIDER_READINESS.md`)
documenting required capabilities, the abstraction layer, environment separation, a per-provider go-live
checklist, assumptions, and migration/replacement strategy — no production provider selected or invented
as fact.

**Also performed as this PRSprint's mandatory pre-phase configuration check:** confirmed
`PAYMENT_SANDBOX_WEBHOOK_SECRET` was still missing from every Vercel environment (the PRSprint 17
finding, unresolved at Phase 5's close), traced it as a purely internal sandbox secret — never a
provider-issued credential, grants no external access — generated and configured it via `vercel env
add` (production + development; preview blocked by a documented Vercel CLI limitation, see §33),
redeployed production, and verified `/api/payments/*` moved from `500 CONFIGURATION_ERROR` to `401
UNAUTHENTICATED`.

## 3. PRSprint 22 result — KYC / KYB / Financial Account Provisioning

**PASS.** Applied the identical diagnosis/fix to `KYC_SANDBOX_WEBHOOK_SECRET` (also missing from every
Vercel environment): configured, redeployed, verified `/api/kyc/submit` moved from `500` to `401`. The
pre-flight audit found the existing Sprint 9/18A KYC state model, sensitive-data minimization, and
admin-override scoping already substantially satisfied this PRSprint's requirements — this was a
hardening/proof pass, not a build. Found and fixed one genuine, previously-undetected gap:
`RelationshipFinancialAccountService.addAccount` had no duplicate-provisioning guard — a repeated
provisioning request with the same `providerAccountRef` created a second financial-account row instead
of returning the existing one. Fixed with a pre-insert idempotent-return check. Added an explicit test
proving `POST /api/profiles/verification` ignores any client-supplied `status`/`decision`/`tier`/`state`
field in the request body (the route never reads it), closing the "no general-purpose admin button that
can simply mark KYC/KYB as verified" concern at the actual API boundary, not just by code inspection.

## 4. PRSprint 23 result — ACH / Bank Linking / Reconciliation

**PASS.** The pre-flight audit found the Sprint 11 ACH mandate state machine, the established
webhook-safety pattern, and the Phase 5 ledger/idempotency/concurrency architecture already applied to
the ACH path in principle — but never proven end-to-end for ACH specifically. This PRSprint proved it
rather than assumed it: new integration tests exercise the real `AchMandateService`/`AchPaymentService`/
`ReconciliationService` stack directly (not the generic `PaymentService.createPayment` path) — a normal
ACH lifecycle (mandate authorize → submit → webhook-driven settlement → balance correctly reduced), a
normal ACH return (zero false-positive reconciliation exceptions, balance correctly restored), and a
deliberately-constructed ledger/provider drift (bypassing the webhook) correctly detected as
`reversal_refund_mismatch`. New route-level tests cover owner-authorize, stranger-rejected (403),
unauthenticated (401), stranger-revoke-rejected (403), unauthenticated-revoke (401). Closed a
previously-unimplemented admin-visibility gap (SPRINT_18C item 109): `LedgerAdminService`'s
`AgreementLedgerView` extended with redacted `paymentAttempts`/`activeAchMandate`/`activeDebitCard`
summaries — provider payment IDs and mandate/card status are surfaced, `bank_account_ref`/`card_token`
are proven absent via a `JSON.stringify` never-contains assertion — and exposed for the first time in
`AdminLedger.tsx` (the backend read existed; nothing in the UI had ever called it).

## 5. PRSprint 24 result — Debit Card Issuance & Card Lifecycle

**PASS.** The one genuine from-scratch build of Phase 6 — no prior sprint had ever modeled a
PAY2PAY-issued, spendable card (distinct from Sprint 12's card-on-file for charging; see
`docs/sprints/SPRINT_18C_PRODUCTION_READY.md` item 30, quoted in the pre-flight findings). Built:
`issued_card`/`card_transaction_event` schema; `CardIssuingProvider` interface +
`SandboxCardIssuingProvider` (registered in the PRSprint 21 capability registry as
`sandbox_card_issuing_mock`); `CardService` (request/activate/freeze/unfreeze/report-lost-stolen with
automatic replacement/cancel); `CardWebhookService`; 8 API routes; a `CardsManager` UI at `/cards`,
linked from `AppNav`. `CARD_SANDBOX_WEBHOOK_SECRET`/`CARD_ISSUING_PROVIDER` provisioned in Vercel
production + development, redeployed, and verified live. Full detail in §16-§24 below.

## 6. Architecture implemented

- **Provider capability registry** (`src/lib/providers/providerCapabilities.ts`): one shared
  `ProviderCapabilityDescriptor` shape and `PROVIDER_CAPABILITY_REGISTRY` for all three provider
  concerns (payments, KYC/KYB, card issuing) — `sandbox_mock`, `sandbox_kyc_mock`,
  `sandbox_card_issuing_mock` — each tagged `environment: "sandbox"`. `getProviderCapabilityDescriptor`,
  `providerSupportsCapability`, and `assertProviderEnvironmentConsistency` are the only functions any
  `get*Provider()` factory calls to resolve or validate a provider.
- **Stable per-concern interfaces**: `PaymentProvider`, `KycKybProvider`, `CardIssuingProvider` — each
  with exactly one implementation registered (a sandbox mock). Business-logic services (`PaymentService`,
  `KycVerificationService`/`VerificationService`, `CardService`) depend only on the interface, never a
  concrete provider class or a specific processor's SDK.
- **Environment-driven runtime switches**: `PAYMENT_PROVIDER`, `KYC_PROVIDER`, `CARD_ISSUING_PROVIDER`
  (all `z.enum(["sandbox"]).default("sandbox")` in `src/config/env.ts`) — adding a real provider later is
  an enum-value + registry-entry + implementation-class change, not a rewrite of any consuming service.
- **Provider → PAY2PAY source-of-truth rule**, applied identically across all three domains: the
  provider is authoritative for facts inside its own infrastructure (a transfer settled, a verification
  result, a card-issuance result); PAY2PAY is authoritative for its own domain state (agreement,
  obligations, schedule, ledger, authorization, tenant ownership, workflow). Provider events are always
  translated through a validated service method, never applied as a direct payload overwrite of an
  arbitrary DB record. `CardService`/`CardWebhookService` have no dependency on `LedgerService`/
  `BalanceService`/`AgreementService` — structurally incapable of posting a card transaction as a ledger
  entry or agreement obligation, matching the identical precedent already established for
  `AchMandateService`/`DebitCardMethodService`.

## 7. Environment separation

`assertProviderEnvironmentConsistency` enforces the one required direction: a `production`-environment
provider descriptor can never be constructed unless `APP_ENV === "production"`. The reverse — a sandbox
provider running inside a production `APP_ENV` — is explicitly permitted, because that is this system's
actual current state everywhere (Vercel production today runs `PAYMENT_PROVIDER=sandbox`,
`KYC_PROVIDER=sandbox`, `CARD_ISSUING_PROVIDER=sandbox`), and forbidding it would make sandbox testing
against the real production deployment impossible. `AdminEnvironmentStatus` surfaces
`paymentProviderEnvironment`/`kycProviderEnvironment` (and, via the same descriptor lookup pattern, the
card-issuing provider's environment) so this is visible to platform admins, not just inferable from
config. Proven in `src/lib/providers/providerCapabilities.test.ts` and
`src/lib/admin/environmentStatus.test.ts`.

## 8. Secret management

Three webhook secrets — `PAYMENT_SANDBOX_WEBHOOK_SECRET`, `KYC_SANDBOX_WEBHOOK_SECRET`,
`CARD_SANDBOX_WEBHOOK_SECRET` — were traced, confirmed as internal sandbox secrets (never provider-issued
credentials), generated, and provisioned in Vercel production and development via `vercel env add`
(piped-stdin form). None were hard-coded and none were placed in Git. Preview-environment provisioning
was attempted for all three and failed identically with a Vercel CLI (`v52.0.0`) `git_branch_required`
bug on the documented "preview, no specific branch" invocation — a known, non-blocking CLI limitation,
not a secret-management gap (production and development, where all real traffic and this phase's live
verification actually run, both succeeded).

## 9. Provider failure normalization

`RequestCardResult`/`CardActionResult`/`ParsedCardWebhookEvent` (mirroring `PaymentProvider`/
`KycKybProvider`'s existing shapes) give `CardService`/`CardWebhookService` one normalized
success/failure shape regardless of which concrete provider is behind the interface. A provider-reported
failure (`CardActionResult.succeeded === false`) is translated into a domain `ValidationError`, never a
raw provider exception leaking through the API boundary — proven in `cardService.test.ts`'s
provider-rejection cases.

## 10. KYC/KYB state model

Unchanged from Sprint 9/18A — confirmed still correct, not re-architected. `pending → verified` /
`pending → rejected`, one profile owns at most one live verification record, and
`VerificationService.isFullyVerified` is the single gate `CardService.requestCard` also now depends on
(a cardholder must be fully identity-verified before a card can even be requested — the "unverified
parties cannot receive live financial capability" rule applied to card issuance directly).

## 11. Sensitive-data minimization (KYC/KYB)

Unchanged, re-confirmed: no raw government-ID number, SSN, or full identity document is stored — the
existing minimization boundary (established pre-Phase-6) was audited during the pre-flight pass and
found already correct.

## 12. Financial account provisioning — duplicate-provisioning fix

`RelationshipFinancialAccountService.addAccount` now pre-checks for an existing, non-disabled account
with the same `providerAccountRef` for the same party and returns it idempotently instead of creating a
duplicate row. A re-add after the original account was disabled correctly creates a fresh account (not
blocked forever by a stale duplicate check). 2 new tests.

## 13. Admin-override scoping

No new admin capability was invented. `POST /api/profiles/verification`'s route body is proven (new
test) to never read a client-supplied status/decision field — verification can only be set via the
existing, already-scoped `recordManualVerificationDecision` admin path, which requires an explicit
reviewer identity, reason, and audit record (pre-existing, re-confirmed, not weakened).

## 14. Bank linking / ACH state machine

Unchanged Sprint 11 `ach_mandate` state machine (`active → revoked`, `active → expired`,
`supersedes_mandate_id` append-only replacement) — re-confirmed correct via the new
`achReconciliation.test.ts` integration coverage rather than re-implemented.

## 15. ACH webhook safety

Unchanged, re-confirmed: signature verification → `(provider, providerEventId)` uniqueness → idempotent
apply. No changes were required to `PaymentWebhookService` for the ACH path — it already routes through
the same webhook-safety pattern as card and card-on-file payments.

## 16. ACH reconciliation

Proven end-to-end for the first time with a dedicated integration test (`achReconciliation.test.ts`, 3
tests): normal lifecycle, normal return, and a deliberately-injected drift correctly flagged as
`reversal_refund_mismatch` by `ReconciliationService`. (One test required an explicit
`provider.simulateSettlement()` call — the sandbox provider's own internal mock record does not
auto-sync with webhook-driven `payment_attempt.status` changes; this is a sandbox-test-setup detail, not
a production reconciliation gap, and is documented inline in the test.)

## 17. ACH failure handling / manual-payment compatibility

Unchanged — the Phase 5 manual off-platform payment path (PRSprint 18) and the ACH path both post
through the same `LedgerService`, and neither was modified by this phase. No regression: full Phase 5
manual-payment test coverage re-ran green as part of the full-suite regression (§32).

## 18. Admin ledger visibility (SPRINT_18C item 109 closure)

`LedgerAdminService.getAgreementLedgerView` extended with three new optional narrow-reader dependencies
(`AdminPaymentAttemptReader`/`AdminAchMandateReader`/`AdminDebitCardMethodReader`), each resolved via a
new adapter class wired to the real `PaymentService`/`AchMandateService`/`DebitCardMethodService`. Every
call site that predates this PRSprint and omits the new dependencies is unaffected (the new fields
simply come back empty/null). `AdminLedger.tsx` gained a new "Agreement lookup — provider references"
card — the first UI entry point for this data; the backend capability existed but was previously
unreachable except by direct API call.

## 19. Card domain model / schema

`issued_card` (party-scoped — individual XOR business, mirroring `financial_account`'s exactly-one-party
CHECK constraint — not agreement-scoped, matching how a real card-issuing product works: one card per
party across all their agreements, not one per agreement) and `card_transaction_event` (append-only,
provider-event-deduplicated via a `(provider, provider_event_id)` unique index). Append-only lifecycle:
`reportLostOrStolen`/replacement never mutate an existing row's card fields — they close the old row and
insert a new one linked via `supersedes_card_id`, mirroring `ach_mandate.supersedes_mandate_id` and
`debit_card_method.supersedes_card_method_id` exactly.

## 20. PCI boundary / sensitive card data

`provider_card_ref` is the provider's own opaque card-object reference — never a PAN, CVV, or PIN.
`card_last4`/`card_brand`/expiry are the same class of non-sensitive display metadata
`debit_card_method` already established as safe to store outside full PCI scope (PCI DSS permits this).
No method on `CardIssuingProvider`, `CardService`, or any route ever accepts or returns a full card
number, CVV, or PIN. `CardsManager` (UI) never displays anything beyond last4/brand/expiry.

## 21. Card lifecycle operations

`requestCard` (idempotency-key insert-then-recheck-on-conflict, mirroring `PaymentService.reserveAttempt`;
requires full identity verification; requires a shipping address for a physical card) → `activateCard`
(only from `issued`) → `freezeCard`/`unfreezeCard` (idempotent no-ops on an already-matching status,
genuine `ValidationError` on an invalid transition — e.g. unfreezing a canceled card) →
`reportLostOrStolen` (closes the card, immediately requests a replacement, links via
`supersedesCardId`) → `cancelCard` (idempotent on already-canceled, rejects cancellation of a
`replaced`/`lost`/`stolen` card). All party-authorized via `authorizeParty`, reusing the existing
`change_payout_configuration` capability (the same one `RelationshipFinancialAccountService` reuses) —
no new capability was invented. 20 tests in `cardService.test.ts`.

## 22. Card webhooks

`CardWebhookService.receiveWebhook`: signature verification → `(provider, providerEventId)` uniqueness
(insert-then-recheck-on-conflict on a genuine race) → idempotent apply. An event referencing an
unknown/stale `providerCardRef` is logged and accepted (never fails the provider's retry loop), matching
the identical pattern already established for `PaymentWebhookService`/`KycWebhookService`. 5 tests in
`cardWebhookService.test.ts`.

## 23. Admin card access

Covered by §18's `AdminDebitCardMethodSummary`/`activeDebitCard` surfacing — status and non-sensitive
metadata only, `provider_card_ref` never exposed, proven via the same `JSON.stringify` never-contains
assertion used for `bank_account_ref`/`card_token`.

## 24. Provider → PAY2PAY source-of-truth rule (card domain)

`CardService`/`CardWebhookService` have zero import of `LedgerService`/`BalanceService`/
`AgreementService`. A card transaction event is recorded for visibility/support/reconciliation only — it
never posts a ledger entry and never affects any agreement's obligation, because spending an already-paid
-out card balance is outside PAY2PAY's own payer-to-creditor obligation tracking (SPRINT_18C items
107-109).

## 25. Idempotency (cross-PRSprint)

- PRSprint 21: N/A (no new provider-originated write path).
- PRSprint 22: `RelationshipFinancialAccountService.addAccount`'s new duplicate-`providerAccountRef`
  guard (§12).
- PRSprint 23: pre-existing ACH mandate/payment idempotency-key paths, re-proven via
  `achReconciliation.test.ts`.
- PRSprint 24: `issued_card.idempotency_key` (unique index) + `CardService.requestCard`'s
  insert-then-recheck-on-conflict; `card_transaction_event`'s `(provider, provider_event_id)` unique
  index + `CardWebhookService`'s identical pattern.

No provider-originated retryable operation relies solely on an in-memory duplicate cache — every one is
backed by a real DB uniqueness constraint.

## 26. Observability / logging

Every new lifecycle transition across all four PRSprints is either audit-recorded (`AuditService.record`,
matching this codebase's 100%-coverage convention for financial-state changes) or structured-logged
(`card_webhook_unknown_card`, `card_request_failed`, `card_activate_failed`, etc. — visible in the test
runs' captured stderr in §32). No log statement anywhere in the new code includes a secret key, access
token, full account number, CVV, full PAN, or a highly sensitive identity value — confirmed by code
review of every `logger.*`/`console.*` call added this phase (all log only IDs, status enums, and
non-sensitive display metadata).

## 27. Database changes

- `issued_card_status` enum, `issued_card_type` enum, `card_transaction_event_type` enum
  (`src/db/schema/enums.ts`).
- `issued_card` table (see §19).
- `card_transaction_event` table (see §19).

No changes to any Phase 1-20 table.

## 28. Migrations

- `drizzle/migrations/0028_prsprint24_card_issuance.sql` (generated, clean, no drift against the
  hand-formatted Supabase migration).
- `supabase/migrations/20260819030000_prsprint24_card_issuance.sql` — **applied to the linked production
  Supabase project (`Paid2You` / `lmpicrmmixpvkwwhcxbh`) via `supabase db push`**, confirmed via
  `supabase migration list` showing `remote: 20260819030000` matching `local: 20260819030000`. The CI
  "Supabase schema drift check" job additionally passed on the post-merge `master` push, independently
  confirming no drift.

## 29. RLS changes

`issued_card` and `card_transaction_event` are both created `.enableRLS()` with zero `CREATE POLICY`
statements — the established PRSprint 02 deny-all-for-anon/authenticated precedent, identical to every
other financial table in this codebase. All access is through the server-role connection plus
`CardService`'s own `authorizeParty` service-layer authorization, never a client-facing RLS policy.

## 30. APIs/services modified

- New: `CardService`, `CardWebhookService`, `CardIssuingProvider`/`SandboxCardIssuingProvider`,
  `DrizzleIssuedCardRepository`, `DrizzleCardTransactionEventRepository`.
- New routes: `POST /api/cards/webhook`, `POST /api/cards/request`, `POST /api/cards/activate`,
  `POST /api/cards/freeze`, `POST /api/cards/unfreeze`, `POST /api/cards/report-lost-stolen`,
  `POST /api/cards/cancel`, `GET /api/cards/list`.
- Modified: `getPaymentProvider`, `getKycProvider` (resolve through the new capability registry);
  `RelationshipFinancialAccountService.addAccount` (idempotent duplicate check);
  `LedgerAdminService.getAgreementLedgerView` (new redacted summaries, §18).

## 31. UI changes

- `src/components/CardsManager.tsx` (new): list/request/activate/freeze/unfreeze/report-lost-stolen/
  cancel, with explicit sandbox-disclosure copy and non-sensitive-only card display.
- `src/app/(app)/cards/page.tsx` (new), linked from `AppNav.tsx`.
- `src/components/admin/AdminLedger.tsx`: new "Agreement lookup — provider references" card (§18).
- `src/components/AdminDashboard.tsx`: explicit LIVE-vs-sandbox provider-environment copy (§6-7).

## 32. Tests added and regression tests executed

New tests this phase: 6 (`providerCapabilities.test.ts`, extended) + 2
(`relationshipFinancialAccountService.test.ts`) + 1 (`profiles/verification/route.test.ts`) + 2
(`ledgerAdminService.test.ts`) + 3 (`achReconciliation.test.ts`, new file) + 5
(`ach/mandate/route.test.ts`, new file) + 20 (`cardService.test.ts`, new file) + 5
(`cardWebhookService.test.ts`, new file) + 6 (`cards/request/route.test.ts`, new file) = **~50 new/
extended test cases**, all passing.

**Full project regression suite: 164 test files / 1241 tests — all passing.** `npx tsc --noEmit` clean.
`npx eslint src` — 0 errors (8 pre-existing warnings, all predating this phase and unrelated to it).
`npm run build` succeeds; `/cards` present in the production build's route manifest.

## 33. CI/Vercel/Supabase results

- **CI (GitHub Actions "Lint, typecheck, test, build"), PR #46:** PASS (2m43s).
- **CI ("Supabase schema drift check"), PR #46:** SKIPPED (by design — this job only runs on a push to
  `master`, not on a PR; see the workflow's own documented condition).
- **CI, post-merge push to `master` (run `32213897314`):** both jobs PASS — "Lint, typecheck, test,
  build" (2m43s) **and** "Supabase schema drift check" (21s, PASS — confirming zero drift between the
  applied migration and the linked production project).
- **Vercel (PR preview build):** PASS — deployment completed successfully.
- **Vercel (production, post-merge):** PASS — new production deployment confirmed `● Ready`; live
  verification against `https://paid2you.com`: `POST /api/cards/webhook` (no signature header) returns
  `400` (not `500 CONFIGURATION_ERROR`), `GET /api/cards/list` (unauthenticated) returns `401` (not
  `500`) — both confirm `CARD_SANDBOX_WEBHOOK_SECRET`/`CARD_ISSUING_PROVIDER` resolve correctly in
  production.
- **Vercel CLI limitation (documented, non-blocking):** preview-environment provisioning of all three new
  webhook secrets failed with the same `git_branch_required` CLI bug already documented for
  `PAYMENT_SANDBOX_WEBHOOK_SECRET` in Phase 5 — production and development succeeded via the piped-stdin
  form.
- **Supabase:** migration `20260819030000` applied to the linked production project and confirmed via
  `supabase migration list` (local == remote for every migration, including this one).

## 34. Production Provider Decision Record

`docs/PRODUCTION_PROVIDER_READINESS.md` — current state recorded honestly as `EXTERNAL BLOCKER — LIVE
FINANCIAL PROVIDER APPROVAL/CONFIGURATION REQUIRED`. No production provider was selected or invented as
fact. The required-capabilities table maps every capability (kyc, kyb, bank_linking, ach_debit,
ach_credit, virtual_account_creation, debit_card_issuing, webhook_delivery, transaction_reconciliation)
to its current sandbox consumer and the abstraction point that will absorb a real implementation.

## 35. External blockers

Two external blockers are recorded, neither resolved by this phase:

1. **Twilio production SMS activation** (PRSprint 15) — unchanged, still pending the Product Owner's
   Twilio compliance profile and messaging registration. Phase 6 did not touch SMS/notification code.
2. **Production financial provider selection/approval** (new, this phase, per
   `docs/PRODUCTION_PROVIDER_READINESS.md`) — no real payment processor, KYC/KYB vendor, ACH/bank-linking
   provider, or card-issuing platform has been selected, contracted, or configured. Every provider
   interface in this codebase has exactly one implementation: a sandbox mock.

## 36. Branch/commits/PR

Branch `phase-6-financial-providers`, 4 commits (one per PRSprint, tagged per the phase's own
convention), PR #46, merged to `master` (merge commit `ee367e4`, CI green on both the PR and the
post-merge push, branch deleted).

## 37. Deferred items (with justification)

1. Production provider selection itself — explicitly out of scope; requires a separate Product Owner
   decision, recorded as `EXTERNAL BLOCKER` rather than invented.
2. Preview-environment webhook-secret provisioning for all three new secrets — blocked by the documented
   Vercel CLI `git_branch_required` bug; production and development (where all real traffic and live
   verification run) both succeeded.
3. A dedicated `issuedCardStatusLabel` UI test — the existing `statusLabels.test.ts` file spot-checks a
   representative subset of registries (not every registry has a dedicated test, matching established
   convention); the new registry entry follows the same "never leak a raw enum" shape as every other
   entry in that file.

## 38. Existing-functionality protection confirmation

**Twilio SMS activation remains externally blocked**, status unchanged in
`docs/prsprints/PRSPRINT_CONTROL.md`. **The Financial Provider external blocker is now additionally
recorded** (§35, item 2) — never claimed resolved by this phase's sandbox-only work. No PRSprint 1-23
functionality was removed, weakened, or had its authorization/RLS posture altered. The full Phase 1-23
regression suite (contained within the 1241-test full-suite run, §32) passed unchanged.

## 39. Final verification — 28-section (A-AB) PASS/FAIL/BLOCKED/NOT APPLICABLE matrix

| § | Area | Result | Evidence |
|---|---|---|---|
| A | Provider Abstraction Layer | PASS | `PaymentProvider`/`KycKybProvider`/`CardIssuingProvider` — one interface per concern, exactly one sandbox implementation each; no service depends on a concrete provider class. |
| B | Capability Model / Registry | PASS | `PROVIDER_CAPABILITY_REGISTRY` (3 entries); `providerCapabilities.test.ts` (6 tests). |
| C | Environment Separation | PASS | `assertProviderEnvironmentConsistency` (one-directional guarantee); `environmentStatus.test.ts` (15 tests). |
| D | Secret Management | PASS | 3 webhook secrets traced/generated/provisioned via `vercel env add`, never hard-coded, never in Git (§8). |
| E | Provider Failure Normalization | PASS | `CardActionResult`/`RequestCardResult` normalized shapes; provider rejection → `ValidationError`, never a raw exception leak. |
| F | KYC/KYB State Model | PASS | Unchanged Sprint 9/18A model, re-confirmed correct (§10). |
| G | Sensitive-Data Minimization (KYC/KYB) | PASS | No raw government-ID/SSN/document stored; re-audited, unchanged. |
| H | Financial Account Provisioning | PASS | Duplicate-provisioning gap found and fixed (§12); 2 new tests. |
| I | Admin-Override Scoping (KYC/KYB) | PASS | No new capability invented; verification-status route proven to ignore client input (§13). |
| J | ACH Mandate State Machine | PASS | Unchanged Sprint 11 model, re-confirmed via `achReconciliation.test.ts`. |
| K | ACH Webhook Safety | PASS | Signature → uniqueness → idempotent-apply, unchanged, re-confirmed. |
| L | ACH Reconciliation | PASS | `achReconciliation.test.ts` (3 tests): normal lifecycle, normal return, injected-drift detection. |
| M | ACH Failure Handling | PASS | Return/failure paths covered in `achReconciliation.test.ts`; manual-payment path unaffected. |
| N | Manual-Payment Compatibility | PASS | Phase 5 manual-payment suite re-ran green, unmodified. |
| O | Card Domain Model | PASS | `issued_card`/`card_transaction_event` schema (§19); append-only, party-scoped, one-of-two-owner CHECK. |
| P | PCI Boundary | PASS | No PAN/CVV/PIN field or code path exists anywhere in the new schema, services, routes, or UI (§20). |
| Q | Card Operations | PASS | `CardService` — 20 tests covering every transition and its authorization/validation guard. |
| R | Card Webhooks | PASS | `CardWebhookService` — 5 tests, including unknown-card-reference non-failure. |
| S | Admin Card Access | PASS | Redacted `AdminDebitCardMethodSummary`; `provider_card_ref` proven absent from admin JSON output. |
| T | Provider → PAY2PAY Source-of-Truth Rule | PASS | `CardService`/`CardWebhookService` have zero `LedgerService`/`BalanceService`/`AgreementService` dependency (§24). |
| U | Idempotency (all four PRSprints) | PASS | Every provider-originated retryable write is backed by a real DB unique constraint, not an in-memory cache alone (§25). |
| V | Observability | PASS | Structured logging + full audit coverage for every new transition; no secret/PAN/CVV/token ever logged (§26). |
| W | Database Migrations & Integrity | PASS | Migration `0028` generated, applied to production, confirmed via `supabase migration list`; CI schema-drift check PASS on `master`. |
| X | Security Testing (negative-test matrix) | PASS | See §41 (12-question Security Review) for the full evidence-backed answer set. |
| Y | UI States & Sandbox Disclosure | PASS | `CardsManager` shows explicit sandbox-only copy; status chips never a raw enum (`issuedCardStatusLabel`). |
| Z | Production Provider Decision Record | PASS | `docs/PRODUCTION_PROVIDER_READINESS.md` — honest `EXTERNAL BLOCKER`, no invented provider. |
| AA | External Dependencies | NOT APPLICABLE | No new external network dependency was integrated this phase (the sandbox providers are entirely internal); the Twilio blocker (PRSprint 15) is unchanged and untouched by Phase 6. |
| AB | Live Money Movement | **BLOCKED — PRODUCT OWNER APPROVAL REQUIRED** | No real ACH transfer, real KYC/KYB submission, real financial account, or real debit card was created, activated, or used. Every provider interface has exactly one sandbox implementation. Remains gated per the phase's own explicit safety boundary until separately and explicitly authorized. |

## 40. Testing-count discipline confirmation

No test was added, removed, or altered merely to hit a target count. Every new test corresponds to a
named PRSprint 21-24 requirement or a concrete gap found during implementation (the duplicate-
provisioning fix, the admin-visibility gap, the from-scratch card domain). No failing test was weakened
or skipped to force a PASS.

## 41. Final Phase 6 Security Review — 12 questions, evidence-backed

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can a user set their own KYC/KYB status? | **No.** | `POST /api/profiles/verification` proven (new test) to never read a client-supplied `status`/`decision`/`tier`/`state` field; the only write path is `recordManualVerificationDecision`, which requires a reviewer identity and is audited. |
| 2 | Can a user view/access another tenant's provider records? | **No.** | `CardService.authorizeParty`/`AchMandateService`/`RelationshipFinancialAccountService` all reject a non-owner, non-staff-capability actor; route-level cross-tenant tests (`cards/request/route.test.ts`, `ach/mandate/route.test.ts`) confirm 403 for a stranger on every mutating action. |
| 3 | Can duplicate events create duplicate money movement or duplicate resources? | **No.** | `(provider, provider_event_id)` unique index on `card_transaction_event`/`payment_webhook_event`/`kyc_webhook_event`; `issued_card.idempotency_key` unique index; `providerAccountRef` duplicate-provisioning guard (§12). All insert-then-recheck-on-conflict, not solely an in-memory cache. |
| 4 | Can webhook signature verification be bypassed? | **No.** | `CardWebhookService.receiveWebhook` (and the pre-existing payment/KYC equivalents) require a valid signature over the raw body before any processing; `POST /api/cards/webhook` returns `400` for a missing signature header, confirmed live in production. |
| 5 | Can a provider ID be substituted to access someone else's resource? | **No.** | Every lookup-by-provider-ref (`findByProviderCardRef`, ACH mandate lookups) is only ever reached after `getAuthorizedRecord`'s party-ownership check on the *internal* record, not the provider ref itself — a guessed/substituted provider ref cannot be used to bypass authorization because the authorization check runs on the resolved internal party, not on client-supplied provider identifiers. |
| 6 | Can bank account credentials leak (logs, API responses, admin views)? | **No.** | `bank_account_ref` is proven absent from `LedgerAdminService`'s admin JSON output (`JSON.stringify` never-contains assertion, `ledgerAdminService.test.ts`); no log statement added this phase includes it. |
| 7 | Can raw card credentials (PAN/CVV/PIN) leak? | **No.** | No field, interface, or code path anywhere in the card domain accepts, stores, returns, or logs a PAN, CVV, or PIN — only `provider_card_ref` (opaque) and `card_last4`/`card_brand`/expiry (non-sensitive display metadata, PCI-DSS-permitted outside full scope). |
| 8 | Can an admin fabricate provider verification (KYC/KYB, card issuance) without going through the provider? | **No new capability was created that could.** | `recordManualVerificationDecision` (KYC/KYB) is a pre-existing, narrowly-scoped, fully-audited override, unchanged and unweakened by this phase. No equivalent "admin marks card issued/active" override exists anywhere in `CardService` — every status transition on `issued_card` requires an actual `CardIssuingProvider` call to succeed first. |
| 9 | Can a provider event bypass the Phase 5 ledger's authoritative posting? | **No.** | `CardWebhookService`/`CardService` have zero dependency on `LedgerService`/`BalanceService` (§24) — structurally incapable of posting a ledger entry, let alone bypassing one. ACH events post through the same unmodified `PaymentWebhookService` → `LedgerService.insertIdempotently` path Phase 5 already hardened. |
| 10 | Can concurrent provider events corrupt balances? | **No new risk introduced.** | Card transactions never touch balances (§24) — no concurrency risk exists there by construction. The ACH/payment path's concurrency guarantees are the unmodified Phase 5 architecture (`concurrencyAndIdempotency.test.ts`, re-run green in the full-suite regression, §32). |
| 11 | Can sandbox mode ever activate real/production financial infrastructure? | **No.** | `assertProviderEnvironmentConsistency` only restricts the production direction; more fundamentally, no production provider implementation exists anywhere in the codebase to activate — every registry entry is `environment: "sandbox"`. There is nothing for a sandbox setting to "escalate" into. |
| 12 | Can production credentials end up used in preview/test environments? | **No.** | No production credential exists yet (§34 — no provider selected). The three secrets provisioned this phase are internal sandbox-only secrets, deliberately not provider-issued, and were only added to production + development (preview provisioning failed via a documented CLI bug and was not worked around with a manual/insecure alternative). |

## 42. Stop condition confirmation

Phase 6 did not begin PRSprint 25, Phase 7, any production UX overhaul, closed beta, or final production
certification. No live financial-provider functionality was activated. Section AB above remains
**BLOCKED — PRODUCT OWNER APPROVAL REQUIRED**.

---

PHASE 6 COMPLETE — PRSprints 21–24 complete. Awaiting ChatGPT/Product Owner Phase 6 review. I will not
begin Phase 7 or PRSprint 25. Live financial activation remains separately gated.
