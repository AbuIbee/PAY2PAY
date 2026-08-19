# Phase 6A Completion Report — Pre-Production Financial UX & Sandbox Removal

**Date:** 2026-08-19
**Branch:** `phase-6a-preproduction-financial-ux` (merged to `master` via PR #47, merge commit)
**Commits:** `c9bbb8e` (feat(ux): remove obsolete development and early-access messaging) →
`cbc330c` (feat(bank): implement tokenized bank connection workflow and bank_connection_id ledger
architecture), merged at `2aabe21`.

## 1. Executive result

**PASS.** Both commits implemented, verified, and merged to `master`. The bank_connection_id/
bank_account_subtype migration was applied to the linked production Supabase project. Production
Vercel deployment was auto-triggered from the merge and verified live. **No live financial
infrastructure was activated** — `PaymentProvider.tokenizeBankAccount` has exactly one implementation
(the sandbox provider); no real bank account was connected and no real money moved. All eight Banking
Invariants (§41 below) are proven, not merely asserted.

## 2. Pre-flight findings

A pre-flight audit (not written up as a separate document, given the phase's tight UX/security scope
already covered by this report) established two load-bearing facts before any code was written:

- **No routing/account-number field, encrypted or otherwise, existed anywhere in the schema before
  this phase** (`financial_account`, `ach_mandate`, `payment_attempt` — grep-verified, zero matches
  repo-wide for `routing_number`/`routingNumber`/`account_number`/`accountNumber`/
  `encryptedAccountNumber`/`encryptedRoutingNumber` or equivalents). The old bank-account form
  (`AddFinancialAccountForm`) never collected them either — it asked the user to *type in* an already-
  opaque "sandbox bank connection token," a stand-in for a real tokenization step that had never been
  built. Banking Invariants 1-3 were therefore already true structurally; this phase's job was to
  replace the sandbox stand-in with a real (fallback-architecture) tokenization flow, not to remediate
  an existing violation.
- **`PaymentProvider.linkBankAccount`/the `financial_account` table's own doc comments already
  anticipated this exact gap** ("This route never sees or logs a raw account/routing number" — a
  promise the old sandbox-token UI never actually had to keep, since it never received one). This
  phase fulfills that pre-existing architectural promise rather than inventing a new one.

## 3. Sandbox terminology audit

Audited: landing page, dashboard, Payment Method / bank connection screens, cards UI, payment
workflows, payment history, onboarding, settings, notifications, banners, empty states, errors,
tooltips, and admin screens. Findings, categorized per this phase's own A-G scheme:

- **Category A (customer-facing production wording) — removed/replaced**: the landing page's early-
  access section (§6); three provider error messages ("Unknown sandbox payment id." /
  "Unknown sandbox card reference." / "Unknown sandbox verification id.") that were reachable in a
  client-visible `ValidationError` response (`toSafeErrorResponse` passes `AppError.message` through
  verbatim) — fixed to "Unknown payment reference." / "Unknown card reference." /
  "Unknown verification reference."; the old bank-account form's "Sandbox bank connection token... enter
  any non-empty test reference" and the debit-card form's "Sandbox card token" placeholder/label text —
  removed along with the form itself (§9).
- **Category B (internal automated tests) — left as-is**: every `*.test.ts(x)` file (74+ files matched
  a raw "sandbox" grep; all are either test files, provider implementation files, or environment
  config — see the static scan, §23).
- **Category C (development provider implementation) — left as-is**: `SandboxPaymentProvider`,
  `SandboxKycProvider`, `SandboxCardIssuingProvider` classes/filenames — still the only registered
  implementation of each provider interface; not customer-facing identifiers.
- **Category D (environment configuration) — left as-is**: `PAYMENT_PROVIDER`/`KYC_PROVIDER`/
  `CARD_ISSUING_PROVIDER` env vars, `providerCapabilities.ts` registry entries (`sandbox_mock` etc.).
- **Category D/admin (AdminDashboard's "(sandbox — no real money moves)" / "(sandbox — not a real
  identity check)" copy) — left as-is, deliberately**: this is a platform-admin-only screen (gated by
  `isAdmin`), and the whole point of that copy is to give administrators honest, non-misleading
  visibility into whether the system is live — removing it would work against Phase 6's own "must show
  explicit environment status to admins" requirement, not serve Phase 6A's "customers must no longer
  see Paid2You presented as a sandbox product" goal (admins are not customers).
- **Category F (internal documentation) — left as-is**: every code-comment reference to "sandbox" in
  this and prior phases' architecture — technically accurate, never customer-facing.
- **Category G (provider abstraction identifiers) — reviewed, not renamed**: `providerName` values
  (`"sandbox_mock"`, `"sandbox_kyc_mock"`, `"sandbox_card_issuing_mock"`) are internal attribution
  strings, never rendered to a customer (confirmed: no customer-facing component interpolates
  `providerName` into visible text) — renaming them would be a needless, disruptive schema-adjacent
  change with zero customer-facing benefit.

## 4. Customer-facing wording removed

- Landing page: "Get on the early-access list" heading, "In active development" eyebrow, its
  supporting copy and bullet list, the `EarlyAccessForm` itself, and the stale, self-contradicting hero
  line ("Early access: account creation, agreements, signatures, and payments are live for signed-up
  users" — contradicted the early-access section directly below it, which said the opposite).
- Trust panel: "PAY2PAY is being built to document and facilitate repayment..." → "PAY2PAY documents and
  facilitates repayment..." (present tense, not in-progress-development framing).
- Three provider error messages (§3).
- Old bank/card account-connection form's sandbox-token language (removed with the form itself).

## 5. Internal sandbox/test infrastructure retained

Everything in Categories B/C/D/F/G above (§3) — no test file, provider implementation, environment
variable, or provider-name identifier was touched for wording reasons. `SandboxPaymentProvider.
tokenizeBankAccount`'s own implementation (§9) is new *functionality*, not a wording change, and is
exactly as much "sandbox" as every other method on that class — it has exactly one implementation, by
design, until a production provider is selected.

## 6. Early-access removal

Removed: the `<section id="early-access">` block, `EarlyAccessForm.tsx` + its test, the exclusively-
consumed `POST /api/early-access` route + its test. **Deliberately not removed**: `earlyAccessLead`
schema (`src/db/schema/marketing.ts`), `DrizzleEarlyAccessLeadRepository`/`getEarlyAccessLeadRepository`/
`testFakes.ts`, and the underlying `early_access_leads` production table + any historical rows in it.
This is now dead application code (nothing imports it) but a deliberate, documented decision: dropping
a table or deleting rows of real historical lead data is a destructive, out-of-mandate action this
phase's UX/wording scope does not call for, and no admin tool ever existed to view this data in the
first place, so nothing regresses by leaving it. If those leads are truly obsolete, a dedicated future
PRSprint should own the explicit decision to purge them.

## 7. Landing-page modifications

See §4/§6. Post-removal verification (`page.test.tsx`, 5 tests, all passing): no dead links (footer
navigation never referenced `#early-access` in the first place — confirmed by inspection before
removal), no orphaned headings, no unused CTA, no inaccessible anchors. The dead `.early-access`/
`.early-access__copy` CSS selectors were removed from `globals.css`; `.early-access-form`/
`.early-access-form__row` were deliberately kept — despite the name, they are this codebase's generic
form-card and two-column-row layout classes, reused across more than a dozen unrelated components
(`SignupForm`, `LoginForm`, `AdminDashboard`, `BusinessProfileForm`, and more) — genuinely load-bearing
shared infrastructure, not early-access-specific, and out of scope to rename.

## 8. Payment Method modifications

`/payment-methods` now leads with "Connect bank account" as the primary action (was "Add bank
account"). `PaymentMethodsList` displays bank accounts as "Checking •••• 4821" / "Savings •••• 4821"
(the exact format this phase's spec names), never a full account number. The empty state now reads "No
bank account connected" / "Connect a bank account so you're ready to fund or receive payments." Debit
card remains a secondary action leading to an honest "Not yet available" page (§10).

## 9. Bank connection architecture

`POST /api/relationships/accounts/bank/connect` → `BankConnectionService.connectBankAccount` — the one
place in the codebase that ever receives a raw routing/account number (the documented fallback
architecture, §11). Server-side validates (ABA routing checksum, 4-17-digit account number,
confirmation match, non-empty account-holder name) independently of the client's own identical checks,
then calls `PaymentProvider.tokenizeBankAccount` exactly once, then persists **only** the returned
`providerAccountRef`/`maskedLast4` plus caller-supplied non-sensitive display metadata
(`institutionDisplayName`, `accountSubtype`) through the existing, unmodified
`RelationshipFinancialAccountService.addAccount` — never a second/duplicate financial-account system.
The sandbox provider validates/tokenizes synchronously (mirroring a real provider's instant-auth
capability, e.g. Plaid Instant Auth), so the route also calls the existing `applyVerificationResult`
immediately, moving the account straight to `verified`.

## 10. Manual-entry architecture

Fully manual routing-number/account-number/confirm-account-number/account-subtype/account-holder-name
entry is supported and is the only entry path today (`BankConnectionForm`) — there is no provider-
hosted "bank login" widget to offer as an alternative, because no live financial provider has been
selected (§11 explains why). Debit-card manual entry (the old `AddFinancialAccountForm`'s card branch)
was **not** rebuilt with an equivalent real flow — it is gated to an honest "Not yet available" state
instead (§ Cards/Payment UI cleanup, item 4 below), a deliberate scope decision: this phase's explicit
Part 3 mandate is bank-account connection specifically; card tokenization has no analogous fallback
architecture built yet and presenting a manual card-token entry field would be strictly worse than
stating the truth.

## 11. Provider tokenization architecture

**Preferred architecture (provider-hosted/tokenized widget) is not available**: no production financial
provider has been selected or contracted (`docs/PRODUCTION_PROVIDER_READINESS.md` records this as an
`EXTERNAL BLOCKER`) — there is no live integration key to embed a hosted Plaid-Link-style widget
against. **Fallback architecture used instead**, exactly as this phase's own rules require or the raw
values transiting Paid2You's backend:

1. Values remain memory-only — local variables inside one request handler / one service method call.
2. Never persisted — `BankConnectionService` never writes them to any repository.
3. Never written to Supabase — no field exists to write them to.
4. Never written to logs — `withErrorHandling` only logs `error.message`/`error.stack`; no thrown error
   in this path ever interpolates the raw values into its message (verified by reading every
   `ValidationError` call site in `bankConnectionService.ts`/`sandboxPaymentProvider.ts`).
5. Never written to audit records — `RelationshipFinancialAccountService.recordAccountAudit` only ever
   records `account.status`, never the input used to create it.
6. Never written to analytics — none exists in this codebase.
7. Never put into queues — none exists in this codepath.
8. Never put into URL parameters — the route is a `POST` with a JSON body; the client never puts the
   values in a query string.
9. Never put into browser storage — `BankConnectionForm` uses only in-memory React state, cleared the
   moment the request settles (success or failure); no `localStorage`/`sessionStorage`/`IndexedDB`/
   cookie write exists anywhere in this component.
10. Never included in exception messages — see point 4.
11. Never sent to monitoring/telemetry — none exists.
12. Immediately exchanged for the provider's safe token/reference — the single
    `provider.tokenizeBankAccount(...)` call.
13. Discarded immediately after exchange — the local variables simply go out of scope; nothing retains
    them.
14. Request bodies are not logged by this application's error handler (see point 4) — no additional
    redaction step was needed because there was nothing being logged to redact.
15. Automated tests proving non-persistence: `bankConnectionService.test.ts` (2 dedicated invariant
    tests, deep `JSON.stringify` inspection of both the returned object and the raw repository row),
    `sandboxPaymentProvider.test.ts` (`tokenizeBankAccount` describe block, including a test that
    inspects `JSON.stringify(provider)` itself to prove the provider instance retains nothing), the new
    route test (response-body inspection).

## 12. Stored banking fields

`financial_account` (bank-account rows) now stores: `providerAccountRef` (opaque token),
`maskedLast4`, `institutionDisplayName` (user-supplied display text, non-sensitive), `bankAccountSubtype`
(checking/savings — new, non-sensitive, nullable, meaningful only for `accountType = 'bank_account'`,
mirroring the existing card-specific columns' identical pattern), `status`, `addedByUserId`,
`individualProfileId`/`organizationId` (ownership), timestamps. **Not stored**: `accountHolderName` (used
only for the provider tokenization call, matching this phase's "do not expand this list casually" rule
— no downstream feature needs it persisted).

## 13. Prohibited banking fields verification

Static repo scan (§23) confirms zero occurrences of `routing_number`/`routingNumber`/
`bank_routing_number`/`bankRoutingNumber`/`account_number`/`accountNumber`/`bank_account_number`/
`bankAccountNumber`/`raw_account_number`/`raw_routing_number`/`encrypted_account_number`/
`encrypted_routing_number` (or camelCase equivalents) anywhere in `src/` or `drizzle/` outside this
report's own prose and the validation utility's own well-named parameters (`routingNumber`/
`accountNumber` — function *parameters*, never persisted fields; see §11 point 2). No remediation
migration was needed because no such field ever existed.

## 14. Database changes

- `financial_account.bank_account_subtype` (new enum column, nullable).
- `payment_attempt.bank_connection_id` (new nullable UUID, FK to `financial_account.id`).
- New enum: `bank_account_subtype` (`checking` | `savings`).

No changes to any pre-existing column, and no change to any Phase 1-24 table's meaning.

## 15. Migrations

- `drizzle/migrations/0029_phase6a_bank_connection_ledger.sql` (generated via `drizzle-kit generate`,
  then renamed to match this repo's `NNNN_<slug>` convention with the journal `tag` updated to match —
  confirmed clean, zero drift, via a second `drizzle-kit generate` reporting "No schema changes, nothing
  to migrate").
- `supabase/migrations/20260819090000_phase6a_bank_connection_ledger.sql` — **applied to the linked
  production Supabase project (`Paid2You` / `lmpicrmmixpvkwwhcxbh`) via `supabase db push`**, confirmed
  via `supabase migration list` (local == remote for every migration, including this one). CI's
  "Supabase schema drift check" additionally passed on the post-merge `master` push, independently
  confirming zero drift.

## 16. RLS changes

None required. Both `financial_account` and `payment_attempt` already have RLS enabled with zero
`CREATE POLICY` statements (PRSprint 02's established deny-all-for-anon/authenticated precedent) — the
new columns are additive and reached only through the same server-role connection and service-layer
authorization every other field on these tables already uses.

## 17. `bank_connection_id` architecture

`payment_attempt.bank_connection_id` references `financial_account.id` directly — `financial_account`
**is** PAY2PAY's internal bank-connection record (Sprint 18A's own table, already party-scoped,
already carrying `providerAccountRef`/`institutionDisplayName`/`maskedLast4`/`status`); no new,
competing, or duplicate table was created, per this phase's own explicit "Do NOT create a competing/
duplicate financial account system" rule. Populated by `AchPaymentService.scheduleInstallmentPayment`/
`createManualPayment`, which now resolve the agreement's active `AchMandateRecord.financialAccountId`
(a pre-existing Sprint 18A column, previously written but never read back out through the service layer
— exposed on `AchMandateRecord` for the first time this phase) and pass it through to
`PaymentService.schedulePayment` as `bankConnectionId`. Null when the active mandate has no known
`financial_account` (a mandate authorized outside the relationship flow, pre-Phase-6A style) — never a
routing/account-number substitute. The provider adapter (`AchMandateFinancialAccountAdapter`) is the one
place that ever resolves `financial_account_id` from a provider-facing operation, matching the "provider
adapter resolves bank_connection_id → provider_reference" architecture this phase's own diagram
specifies.

## 18. Ledger changes

No change to `LedgerService`, `BalanceService`, `ReconciliationService`, or any ledger table
(`ledger_account`/`ledger_journal_entry`/`ledger_posting`) — the Ledger Payment-Source Rule is satisfied
at the `payment_attempt` level, the row every ledger journal entry already links to and reaches
"transitively" (this codebase's own established precedent, per `ledger.ts`'s doc comment: a journal
entry reaches its provider reference *through* `payment_attempt`, not by duplicating it onto the ledger
row itself) — `bank_connection_id` follows the identical pattern rather than being redundantly copied
onto `ledger_journal_entry`. `LedgerAdminService`'s `AdminPaymentAttemptSummary` and `AdminLedger.tsx`
now additionally surface `bankConnectionId` (safe — PAY2PAY's own internal id, never a credential) for
support visibility.

## 19. Consent/authorization architecture

Connecting a bank account (`BankConnectionService.connectBankAccount`) creates **only** a
`financial_account` record — it does not create, touch, or imply any ACH mandate/debit authorization.
Actually authorizing a specific agreement's automatic debits remains the pre-existing, separate, explicit
`AchMandateService.authorize` step (Sprint 11), which still records its own `authorizedAt` timestamp and
audit trail independently. This directly satisfies this phase's explicit rule: **"Do not silently treat
'Connect Bank Account' as unlimited authorization for any future debit."** No consent record anywhere in
this codebase (existing or new) contains a raw routing/account number.

## 20. Logging protections

Audited every `logger.*`/structured-log call reachable from the new bank-connection code path
(`withErrorHandling`, `BankConnectionService`, `SandboxPaymentProvider.tokenizeBankAccount`) — none logs
a request body, and no thrown error's message ever interpolates a raw routing/account number (§11 point
4). No new centralized redaction helper was needed because no log call in this path ever receives the
raw values in the first place — the safest form of redaction is never producing the log line that would
need it.

## 21. Browser-storage protections

`BankConnectionForm` holds `routingNumber`/`accountNumber`/`accountNumberConfirm` only in transient
`useState` — never `localStorage`/`sessionStorage`/`IndexedDB`/a cookie/a URL parameter/a URL fragment.
The values are explicitly cleared (`setRoutingNumber("")` etc.) the moment the connect request settles,
whether it succeeds or fails, and are never referenced again by any other component (they are not lifted
to a shared/global store).

## 22. Supabase sensitive-data verification

Verified via: schema inspection (`financial_account`/`payment_attempt` column lists, §13/§14), migration
inspection (the applied SQL contains no routing/account-number column), model inspection
(`FinancialAccountRecord`/`PaymentAttemptRecord` TypeScript shapes), repository search (`Drizzle*
Repository` classes' `toRecord`/`insert` functions), serialization inspection (every relevant test's
`JSON.stringify` deep-inspection, §11 point 15), and the relevant tests themselves (§23-24). No customer
credential was queried or logged while performing this inspection — the audit was static (code/schema
reading), never a live data query against real customer records.

## 23. Security tests

New negative-security coverage, added this phase:

- Client supplying its own provider account ID / a client-controlled `providerAccountRef` — not
  applicable to the new bank-connect route (it never accepts a client-supplied provider reference; the
  provider reference is always server-computed from `tokenizeBankAccount`'s own result).
- A stranger attempting to connect a bank account for someone else's profile — 403, both at the service
  layer (`bankConnectionService.test.ts`) and the route layer (`route.test.ts`).
- Unauthenticated bank-connect request — 401 (route layer).
- Malformed routing number reaching the service layer despite passing zod's own loose string check —
  400, proving server-side validation is the real gate, independent of any client-side check.
- Raw routing/account number inserted through the actual API request body — proven absent from the
  persisted record, the returned object, and the HTTP response body (§11 point 15).
- No field on the persisted record or the payment_attempt record is or resembles an encrypted full
  account/routing-number substitute (`achPaymentBankConnectionProvenance.test.ts`'s field-name-scanning
  test).

## 24. Regression tests

Full project suite: **165 test files / 1249 tests, all passing** (§27). No pre-existing test was
weakened, skipped, or altered to force a pass; the new/updated tests are `PaymentMethodsList.test.tsx`
(updated fixtures/copy), `(marketing)/page.test.tsx` (updated + 2 new tests), and the new files listed
in §23/§9.

## 25. Phase 5 regression

Phase 5's full financial/ledger/idempotency/concurrency suite (`paymentLedgerIntegration.test.ts`,
`balanceReconstruction.test.ts`, `concurrencyAndIdempotency.test.ts`, `ledgerService.test.ts`,
`balanceService.test.ts`, `reconciliationService.test.ts`) ran unmodified and green as part of the full
suite — no Phase 5 file was touched by this phase except the additive `PaymentAttemptRecord`/
`PaymentAttemptRepository` field (`bankConnectionId`, always optional/nullable, defaulting to `null`
everywhere it isn't explicitly set).

## 26. Phase 6 regression

Phase 6's full provider/KYC/ACH/card suite (`providerCapabilities.test.ts`, `cardService.test.ts`,
`cardWebhookService.test.ts`, `achMandateService.test.ts`, `achPaymentService.test.ts`,
`achReconciliation.test.ts`, `ledgerAdminService.test.ts`) ran unmodified (aside from the additive
`AdminPaymentAttemptSummary.bankConnectionId` field and one test fixture update to match it) and green.

## 27. Full-suite result

**165 test files / 1249 tests pass.** (Up from Phase 6's 164/1241 — net of 2 new/updated test files
and the 2 deleted ones, `EarlyAccessForm.test.tsx` and `AddFinancialAccountForm.test.tsx`.)

## 28. Typecheck

`npx tsc --noEmit` — clean.

## 29. Lint

`npx eslint src` — 0 errors, 8 pre-existing warnings (all predate this phase, unrelated to it — the
same 8 reported in the Phase 6 completion report, unchanged).

## 30. Production build

`npm run build` — succeeds. `/api/relationships/accounts/bank/connect` present in the route manifest;
`/api/early-access` confirmed absent.

## 31. CI

- **PR #47 checks**: "Lint, typecheck, test, build" PASS (2m45s); "Vercel" PASS (preview deployment
  completed); "Supabase schema drift check" SKIPPED (by design — PR-only, runs on `master` push).
- **Post-merge `master` push (run `32255427545`)**: both jobs PASS — "Lint, typecheck, test, build"
  (2m57s) **and** "Supabase schema drift check" (21s, PASS — independently confirming zero drift).

## 32. Supabase

Migration `20260819090000` applied to the linked production project and confirmed via
`supabase migration list` (local == remote for every migration, including this one).

## 33. Vercel

Production deployment confirmed `● Ready` post-merge. Live verification against `https://paid2you.com`:
`POST /api/early-access` → `404` (route gone); `POST /api/relationships/accounts/bank/connect`
(unauthenticated) → `401` (not `500` — confirms the route resolves correctly in production); the landing
page HTML contains no "early-access list" or "in active development" text; `GET /cards` → `200`.

## 34. Schema drift

**PASS** — see §31/§32. CI's dedicated schema-drift job passed against the linked production project
after this phase's migration was applied.

## 35. Branch

`phase-6a-preproduction-financial-ux`.

## 36. Commits

`c9bbb8e` (feat(ux): remove obsolete development and early-access messaging) → `cbc330c`
(feat(bank): implement tokenized bank connection workflow and bank_connection_id ledger architecture).

## 37. PR

PR #47, merged to `master` (merge commit `2aabe21`, CI green on both the PR and the post-merge push,
branch deleted).

## 38. Remaining external provider blockers

Unchanged from Phase 6, neither resolved nor worsened by this phase:

1. **Twilio production SMS activation** (PRSprint 15) — still pending Product Owner action.
2. **Production financial provider selection/approval** (Phase 6) — still no real payment processor,
   bank-linking/tokenization provider, KYC/KYB vendor, or card-issuing platform selected or contracted.
   `PaymentProvider.tokenizeBankAccount` has exactly one implementation, same as every other provider
   method in this codebase.

## 39. Remaining production-activation blockers

Unchanged: real ACH initiation, real money movement, production debit-card issuance, production
KYC/KYB submission, and live financial-provider activation all remain blocked pending separate Product
Owner authorization, per this phase's own explicit Production-Activation Boundary.

## 40. Remaining risks

1. **Debit-card-on-file (Sprint 12's card-charging concept) has no production tokenization architecture
   yet** — gated to an honest "Not yet available" state rather than built out, since this phase's Part 3
   mandate was bank-account connection specifically. A future phase should give it the same tokenize-
   and-discard treatment this phase gave bank accounts, once a provider decision is made.
2. **No micro-deposit or asynchronous bank-verification flow exists** — the sandbox provider
   validates/verifies synchronously, so the "Verification Required"/"Verification Pending"/"Failed" UI
   states (already implemented, since they reuse the pre-existing `FinancialAccountStatus` enum and
   `financialAccountStatusLabel` registry) are not organically reachable through today's sandbox
   provider. This is an accurate reflection of current capability, not a hidden gap — a real,
   asynchronously-verifying provider would exercise these states naturally without any further UI work.
3. **`early_access_leads` historical data was not purged** (§6) — a deliberate, documented, low-risk
   deferral, not an oversight.
4. **`.early-access-form`/`.early-access-form__row` CSS class names remain**, despite the legacy name —
   deliberately not renamed (§7); purely cosmetic to a future reader, zero functional risk.

## 41. Banking Invariant Report

| Invariant | Status | Evidence |
|---|---|---|
| 1. Paid2You does not store full account numbers. | **PROVEN** | No such field exists in `financial_account` or any other table (schema inspection, §13); `bankConnectionService.test.ts`/route test deep-inspect the stored repository row and the HTTP response, confirming the raw value never appears anywhere. |
| 2. Paid2You does not store full routing numbers. | **PROVEN** | Same evidence as invariant 1 — no such field exists; confirmed absent from every persisted/returned structure. |
| 3. Paid2You does not encrypt-and-store full routing/account numbers "just in case." | **PROVEN** | No `encrypted_account_number`/`encrypted_routing_number`-shaped field exists anywhere (static scan, §13/§23) — there is no encrypted archive to find because none was ever built. |
| 4. Paid2You stores only appropriate safe banking connection information. | **PROVEN** | `financial_account` stores exactly: `providerAccountRef`, `institutionDisplayName`, `accountType`/`bankAccountSubtype`, `maskedLast4`, `status`, timestamps, `addedByUserId`/ownership fields (§12) — nothing beyond this list. |
| 5. The authoritative ledger identifies payment sources using internal `bank_connection_id`, never routing/account number. | **PROVEN** | `payment_attempt.bank_connection_id` (§17); `achPaymentBankConnectionProvenance.test.ts` proves it end-to-end against the real service stack and proves no field on the record ever contains a routing/account number. |
| 6. A provider or financial processor retains the underlying sensitive bank credential relationship. | **PROVEN (by construction)** | `providerAccountRef` is the only durable reference PAY2PAY keeps — an opaque token the (sandbox, today) provider issued; PAY2PAY has no code path that could reconstruct a raw routing/account number from it. |
| 7. Historical financial records remain auditable even after a bank connection is removed or replaced. | **PROVEN** | `financial_account` rows are never hard-deleted (`disableAccount` only ever sets `disabledAt`); `payment_attempt.bank_connection_id` is not `ON DELETE CASCADE` — a disabled/replaced bank connection's id remains a valid, resolvable historical reference. |
| 8. Raw banking credentials do not appear in logs, audit events, browser storage, analytics, URLs, or Supabase. | **PROVEN** | §20 (logging), §19 (audit — only `account.status` is ever recorded), §21 (browser storage), §11 point 8 (URLs — `POST` with a JSON body), §13/§22 (Supabase). No analytics infrastructure exists in this codebase to check. |

**Every invariant is proven with concrete evidence — none is asserted without it, and none is hidden.**
Phase 6A is complete under this report's own stated completion rule ("If any invariant cannot be proven,
Phase 6A is not complete").

## 42. Final verification — A-AE matrix

| § | Area | Result | Evidence |
|---|---|---|---|
| A | Sandbox Wording Removed From Customer UI | PASS | §3-4; three provider error messages fixed; old sandbox-token form deleted. |
| B | Early-Access Content Removed | PASS | §6-7; `page.test.tsx` proves the section/text is gone. |
| C | Active-Development Content Removed/Updated | PASS | §4 (hero line, trust-panel copy); `page.test.tsx`'s "does not present the product as a sandbox or development demo" test. |
| D | Payment Method Production UX | PASS | §8; "Connect bank account" primary action, "Checking •••• 4821" display format. |
| E | Bank Account Connection | PASS | §9; `POST /api/relationships/accounts/bank/connect`, live-verified 401 (not 500) in production. |
| F | Manual Bank Entry Capability | PASS | §10; `BankConnectionForm`. |
| G | Provider Tokenization / Secure Collection | PASS (fallback architecture, documented) | §11; `tokenizeBankAccount`, 15/15 fallback-rule requirements enforced. |
| H | Full Account Number Non-Persistence | PASS | §41 invariant 1. |
| I | Full Routing Number Non-Persistence | PASS | §41 invariant 2. |
| J | No Encrypted Credential Retention | PASS | §41 invariant 3. |
| K | Last-Four-Only Display | PASS | §8; `PaymentMethodsList` never renders more than `maskedLast4`. |
| L | Provider Reference Storage | PASS | §12; `providerAccountRef` stored, never the raw value. |
| M | Bank Verification State | PASS | §9; `FinancialAccountStatus` (`pending_verification`/`verified`/`failed`/`disabled`), reused unmodified. |
| N | Bank Connection State | PASS | Same enum/field as M — connection and verification state are the same `status` field on `financial_account`, matching the pre-existing Sprint 18A model. |
| O | Consent / Authorization Records | PASS | §19; connecting a bank account never implies ACH debit authorization — that remains `AchMandateService.authorize`'s own separate, explicit step. |
| P | User Ownership | PASS | `authorizeParty` (unmodified, pre-existing) enforced on every `addAccount` call, including via the new bank-connect route; route-test-proven 403 for a stranger. |
| Q | Tenant Ownership | PASS | Same authorization path — business-party bank connections are gated by the same `change_payout_configuration` capability check as every other financial-account mutation. |
| R | `bank_connection_id` Architecture | PASS | §17. |
| S | Ledger Contains No Bank Credentials | PASS | §18; `achPaymentBankConnectionProvenance.test.ts`. |
| T | Logging Redaction | PASS | §20. |
| U | Browser Storage Protection | PASS | §21. |
| V | Supabase Sensitive-Data Protection | PASS | §22. |
| W | RLS | PASS | §16 — both affected tables already deny-all, additive columns only. |
| X | Authorization | PASS | §23 (403/401 route-level tests); server-side validation independent of client checks. |
| Y | Phase 5 Regression | PASS | §25. |
| Z | Phase 6 Regression | PASS | §26. |
| AA | Full Regression Suite | PASS | §27 — 165/165 test files, 1249/1249 tests. |
| AB | CI | PASS | §31. |
| AC | Vercel | PASS | §33 — live-verified against production. |
| AD | Supabase | PASS | §32. |
| AE | Schema Drift | PASS | §34. |

## Stop condition confirmation

Phase 6A did not begin PRSprint 25, Phase 7, real ACH initiation, production debit-card issuance,
production KYC/KYB submission, or live financial-provider activation.

---

PHASE 6A COMPLETE — Pre-Production Financial UX & Sandbox Removal gate complete. Banking credential
non-persistence and bank_connection_id ledger architecture verified. Awaiting ChatGPT/Product Owner
review. I will not begin Phase 7 or PRSprint 25.
