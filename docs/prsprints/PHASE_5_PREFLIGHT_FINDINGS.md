# Phase 5 Pre-Flight Findings — PRSprints 17-20 (Payments & Ledger)

**Date:** 2026-08-18
**Scope:** Read-only audit performed before any Phase 5 implementation, per the Phase 5 kickoff's
"PHASE-WIDE PRE-FLIGHT" instructions. Covers existing payment, agreement, schedule, ledger, webhook,
database, money, currency, status-transition, audit, and idempotency code plus current RLS and tests.

## 1. Executive summary

The existing payment/ledger architecture (Sprint 5, 9-13) is substantially more mature than a typical
"Phase 5 starts from zero" assumption. Money is already integer-minor-units everywhere authoritative;
the schedule engine is already deterministic; the ledger is already double-entry, append-only, and
idempotent via unique constraints. Phase 5's real work is concentrated in a smaller number of genuine,
concrete gaps rather than a from-scratch build. Those gaps are listed in §7.

## 2. PRSprint 17 (Schedule & Monetary Math) — existing coverage

- `src/lib/agreements/schedule.ts` (`computeSchedule`/`addFrequencyInterval`): integer-only inputs
  (`Number.isInteger` guards), deterministic UTC-based date math, correct month-end clamping (Jan 31 +
  1mo -> Feb 28/29, Dec 31 + 1mo -> Jan 31), final-installment-absorbs-remainder rounding with a
  "nothing lost or invented" invariant already under test (`schedule.test.ts`, 8 tests).
- No authoritative floating-point money math exists except one input-boundary conversion:
  `src/lib/csvImport/csvImportService.ts`'s `parseDollarsToMinorUnits` (`parseFloat` + regex-guarded
  2-decimal input + `Math.round`). Judged safe (one-time, non-accumulating, regex-bounded) but flagged
  here for explicit record rather than silent pass-over, per Hard Stop discipline.
- Display-only formatting (`src/lib/ui/money.ts`, `templates.ts`, `agreementPdf.ts`) is correctly
  separated from authoritative storage — confirmed safe.
- Currency is explicit end-to-end (`agreement.currency`, `payment_attempt.currency`,
  `ledger_journal_entry.currency`), defaulting to "USD", never inferred.
- Schedule-modification authorization: `AgreementService.creditorDecide`'s counter branch is the only
  code path that rewrites `installment_schedule_item` rows after draft creation, gated to the creditor
  role only, and only while the version is unsigned (`if (version.signedAt) throw`). Confirmed correct
  — no gap found here.

**Conclusion:** PRSprint 17 is a hardening/verification pass, not a build. See §7 for the residual gaps.

## 3. PRSprint 19 (Authoritative Ledger) — existing coverage

- `ledger_journal_entry` unique on `(payment_attempt_id, entry_type)` — structurally idempotent
  posting; `LedgerService`'s every posting method is get-existing-or-post-once.
- Append-only by construction: no `update`/`delete` method exists anywhere on
  `LedgerJournalEntryRepository`/`LedgerPostingRepository`. Corrections are new rows
  (`refund`/`reversal`/`dispute_adjustment`/`admin_adjustment`), never rewrites.
- `LedgerService.assertBalanced` enforces the double-entry invariant in application code before every
  insert (documented as intentional — Postgres has no cross-row CHECK for this).
- `BalanceService.getAgreementBalance` is the documented single source of truth for a computed balance
  — reconstructed from `agreement_version.terms` (read-only) + `LedgerService` journal history only,
  never a cached/mutable balance column (none exists in the schema).
- `ReconciliationService` already implements all 10 of PRSprint 19/20-relevant exception types with
  live detectors, re-runnable idempotently.
- Obligation (agreement principal, `agreement_version.terms`) vs. money movement (ledger) is already
  cleanly separated — the ledger never writes to `agreement`/`agreement_version`.

**Conclusion:** the ledger substantially already satisfies PRSprint 19. Residual gap: nothing currently
proves reconstructability end-to-end via an explicit written test matrix, and reversal/refund linkage
has real tests but no dedicated "reconstruct from ledger alone" assertion. See §7.

## 4. PRSprint 20 (Idempotency & Concurrency) — existing coverage

- `payment_attempt.idempotency_key` unique + `PaymentService.reserveAttempt`'s insert-then-recheck race
  handling (catch on insert conflict, re-query by idempotency key).
- `payment_webhook_event` unique on `(provider, provider_event_id)` — replay protection, checked before
  any state change in `PaymentWebhookService.receiveWebhook`.
- `ledger_journal_entry` unique on `(payment_attempt_id, entry_type)` — duplicate-webhook-driven
  ledger posting is already structurally prevented.
- `PaymentAttemptRepository.findOpenByInstallment` prevents a second in-flight attempt against the same
  installment while one is already unresolved.
- **Gap confirmed:** every existing test (`paymentService.test.ts`, `paymentWebhookService.test.ts`,
  `paymentLedgerIntegration.test.ts`, etc.) uses in-memory repository fakes executed synchronously by
  Vitest — there is no live-Postgres integration harness anywhere in this codebase (confirmed by
  `vitest.config.ts` and a repo-wide search for `testcontainers`/RLS-integration test files: none
  exist). This is an established, repo-wide testing convention (30+ prior sprints), not a Phase-5-local
  choice, so Phase 5 will follow it rather than introduce new test infrastructure — but "genuine
  adversarial/race tests (not serial double-invocation)" will be written by making the in-memory fakes'
  `insert` methods model the same two-callers-both-pass-the-check-then-race-to-insert shape a real
  unique-constraint race produces (interleaved `Promise.all`, second write rejected the same way
  `PaymentService.reserveAttempt`'s own catch block already expects), not merely calling a method twice
  in sequence.

## 5. RLS / security

All four Sprint-10 ledger tables (`ledger_account`, `ledger_journal_entry`, `ledger_posting`,
`reconciliation_exception`) have RLS enabled AND `REVOKE ALL ... FROM anon, authenticated` — i.e. these
tables are reachable only through the server-role DB connection, never a client-side Supabase query.
Authorization is enforced entirely in the TypeScript service layer (e.g.
`PaymentService.getAuthorizedRecord`'s payer-or-recipient / recipient-only checks). This is the
established, correct pattern for every financial table in this codebase and Phase 5 will follow it,
not introduce row-level client access.

## 6. Sprint 15 partial-payment / settlement lineage (relevant to PRSprint 18)

- `PartialPaymentService` (Sprint 15) already implements the propose/accept/reject/counter negotiation
  and `recordPayment` linking, by design never touching `agreement.status` — "acceptance of a partial
  payment must not automatically constitute full settlement."
- `SettlementService` (Sprint 15) already implements the one existing agreement-completion write path:
  `recordSettlementPayment` is the **only** place in the entire codebase that ever writes
  `agreement.status = "settled_in_full"`.
- **No code path anywhere writes `agreement.status = "paid_in_full"`.** `BalanceService` computes a
  read-only `settlementState` of `"unpaid" | "partially_paid" | "paid_in_full" | "overpaid"`, but this
  value is never consumed to drive `agreement.status`. This is the central PRSprint 18 gap — see §7.

## 7. Concrete gaps identified (the real Phase 5 implementation work)

1. **No deterministic full-payment completion.** (PRSprint 18, primary gap.) A normal
   (non-settlement) agreement that reaches `amountPaidMinorUnits === originalPrincipalMinorUnits` via
   ordinary installment payments never transitions `agreement.status`. Fix: a completion check, wired
   from the same point `PaymentWebhookService`/`FailedPaymentWorkflowService` already handle
   `payment.succeeded`, that recomputes `BalanceService.getAgreementBalance` and — idempotently, only
   from an in-progress status — transitions to `"paid_in_full"`.
2. **No explicit overpayment policy.** (PRSprint 18.) Nothing today prevents a payment from pushing
   `amountPaidMinorUnits` past `originalPrincipalMinorUnits`; `BalanceService` merely labels the result
   `"overpaid"` with no consequence anywhere. No ledger account type exists for a refundable credit
   balance (`ledgerAccountTypeEnum` has none), and no spec text mandates permitting it. Decision (see
   completion-report for full rationale): **overpayment is rejected at payment-creation time** for any
   agreement-linked payment — a payment whose amount would exceed the agreement's current remaining
   balance is blocked with a clear `ValidationError` before it ever reaches a provider. This is
   explicit, deterministic, requires no new account type, and matches this codebase's existing
   "nothing lost or invented" / no-silent-remainder precedent.
3. **No manual/off-platform payment recording.** (PRSprint 18.) The existing "manual" ACH/debit-card
   routes (`/api/ach/payments/manual`, `/api/debit-card/payments/manual`) mean "manually-triggered
   real-provider payment," not "off-platform payment recorded for evidentiary purposes" (e.g. cash,
   check, external transfer). PRSprint 18 explicitly requires the latter as a distinct concept from a
   provider-verified payment, with **optional** recipient confirmation. This does not exist and will be
   built as a new `PaymentService.recordManualOffPlatformPayment` path (new `payment_method` enum
   value, immediate `succeeded` status — no provider round-trip — direct ledger posting, optional
   `confirmManualPayment` by the counterparty).
4. **No installment-level partial-payment tracking against `installment_schedule_item.status`.**
   (PRSprint 18.) `InstallmentStatusRepository` only supports `markPastDue`/`markPaid` (binary) — a
   partial payment against a specific installment does not yet move it to any intermediate state
   distinguishable from "scheduled." Given `installment_item_status` enum is a closed, migration-gated
   vocabulary (`scheduled`/`paid`/`past_due`/`waived`) with no spec text requiring a new
   `partially_paid` value, and the agreement-level `BalanceService` already tracks aggregate paid/
   remaining precisely, this will be resolved by reading balance state at the agreement level (already
   exact) rather than adding new schema surface not required by the spec.
5. **No end-to-end "reconstruct balance from ledger alone" test matrix.** (PRSprint 19.) Individual
   ledger behaviors are well-tested but PRSprint 19's specific 10 reconciliation scenarios (new
   obligation, one payment, partial, multiple, completion, reversal, duplicate event, concurrent event,
   admin correction, unauthorized-mutation attempt) are not yet asserted as one explicit suite.
6. **No genuine concurrent/race test suite.** (PRSprint 20.) See §4 — will be added using the
   established in-memory-fake test architecture, modeling true interleaving rather than serial
   double-calls.
7. **`csvImportService.ts`'s `parseDollarsToMinorUnits`** — no explicit test today proves it never
   introduces rounding drift at its documented safe boundary. Will add a boundary test as part of
   PRSprint 17 rather than changing the (already-safe) implementation.

## 8. Non-negotiable rules re-confirmed against existing code

- No authoritative floating-point money math exists to remove (§2) — the "no floating point" rule is
  already satisfied; Phase 5 must not introduce any.
- Server authority is already the exclusive pattern (client never supplies amount/status directly to a
  trusted field — `PaymentService.createPayment` always re-verifies).
- Historical immutability is already the exclusive ledger pattern (§3) — Phase 5 must preserve this,
  not add any update/delete path.
- Tenant isolation: RLS + revoke-all + service-layer authorization (§5) — Phase 5 must not weaken this
  or introduce a client-reachable financial table.

## 9. Execution order for this phase (per the Phase 5 kickoff's pass-gate requirement)

17 (hardening + tests for existing engine + the csvImport boundary test) -> verify -> 18 (completion
detection + overpayment policy + manual/off-platform payment) -> verify -> 19 (reconstruction test
matrix + any hardening the 18 changes require) -> verify -> 20 (concurrency/idempotency test suite +
any gaps 17-19 surfaced) -> full Phase 5 verification.
