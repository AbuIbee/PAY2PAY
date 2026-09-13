import "server-only";
import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem, ledgerJournalEntry, ledgerPosting, paymentAttempt } from "@/db/schema";
import { ValidationError } from "@/lib/errors";
import { computeInstallmentSettlement, type InstallmentSettlementSnapshot } from "./installmentSettlement";
import type { LedgerJournalEntryRecord } from "./ledgerService";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * R11 TARGETED PROVIDER-RESERVATION CORRECTION: the exact set of `payment_attempt.status` values
 * meaning "this attempt may still resolve to succeeded OR failed — it has not yet reached any
 * terminal or cleared outcome, so it reserves its installment's remaining capacity even though no
 * `payment_cleared` ledger entry exists for it yet." Read directly from
 * `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION` (paymentService.ts) — this is EXACTLY the union of every
 * source status that matrix allows to reach `"succeeded"` or `"failed"` — never a separately
 * hand-maintained list. Matches the pre-existing `findOpenByInstallment`'s own status list exactly
 * (drizzlePaymentAttemptRepository.ts) — this constant does not change that meaning, only makes it
 * authoritative (tx-bound, under the installment lock) rather than a racy, pre-transaction optimism
 * check. Every OTHER status (`succeeded`, `failed`, `canceled`, `refunded`, `disputed`, `reversed`,
 * `returned`) is terminal for reservation purposes: `succeeded` money is already counted by
 * `computeInstallmentSettlementWithinTx`'s own cleared-ledger arithmetic; every other terminal status
 * reserves nothing.
 */
export const UNRESOLVED_PAYMENT_ATTEMPT_STATUSES = ["pending", "scheduled", "submitted", "processing"] as const;

/**
 * R11 TARGETED PROVIDER-RESERVATION CORRECTION: closes the confirmed TOCTOU gap where two
 * concurrent, provider-routed reservations against the SAME installment (each individually checked
 * only against currently-CLEARED ledger money, never against each other's own still-unresolved
 * existence) could both be created — the installment `FOR UPDATE` lock alone only serializes the
 * ORDER two transactions run in; it does not make an unresolved reservation part of the financial
 * evidence the second transaction's own fresh read observes. Enforces "AT MOST ONE FINANCIALLY-
 * UNRESOLVED PAYMENT ATTEMPT MAY EXIST FOR A GIVEN INSTALLMENT" — deliberately NOT an in-flight
 * reservation ledger, NOT a change to the cleared-money settlement arithmetic; a purely structural
 * existence check, run inside the SAME transaction and under the SAME installment row lock every
 * other R11 mutation path already acquires.
 *
 * R11 CORRECTION PASS A (Defect A1 — SUCCEEDED-BEFORE-LEDGER RESERVATION GAP): "financially
 * unresolved" is now TWO conditions, combined with OR, never just the status list alone:
 *   (1) `status IN UNRESOLVED_PAYMENT_ATTEMPT_STATUSES` — an attempt that may still resolve to
 *       "succeeded" OR "failed" (unchanged from the original targeted correction).
 *   (2) `status = 'succeeded' AND NO "payment_cleared" ledger_journal_entry row exists for it yet` —
 *       closes the confirmed race where `PaymentTransitionCoordinator.applyTransition` durably
 *       commits `payment_attempt.status = 'succeeded'` in its OWN transaction, strictly BEFORE
 *       `PaymentWebhookService.postLedgerEntryRequired` posts that success's own `payment_cleared`
 *       entry in a LATER, separate step (see `paymentWebhookService.ts`'s own sequential
 *       `applyTransition` -> `postLedgerEntryRequired` ordering) — during that window the money is
 *       durably "succeeded" but not yet represented in `computeInstallmentSettlementWithinTx`'s own
 *       cleared-ledger arithmetic, so a second reservation checked only against THAT arithmetic could
 *       pass even though the first attempt's own contribution has not yet been counted.
 *   Deliberately NOT "treat every succeeded attempt as permanently unresolved" (the coordinator's own
 *   explicit instruction) — the INSTANT a succeeded attempt's own `payment_cleared` entry is posted,
 *   condition (2) stops matching it (the `NOT EXISTS` subquery now finds that row), so it falls out of
 *   this check entirely and its money is represented purely through the settlement arithmetic below —
 *   never a second, competing source of truth, and never a permanent block on a later, legitimate
 *   sequential partial payment against the same installment's now-reduced remaining amount.
 *
 * MUST be called AFTER the installment row is locked `FOR UPDATE` in the caller's own transaction,
 * and BEFORE the new `payment_attempt` row is inserted.
 *
 * IDEMPOTENCY: `excludeIdempotencyKey` is the NEW attempt's own idempotency key — a row sharing that
 * exact key is never "competing" (it is either this same logical request racing itself, or an
 * already-resolved replay), so it is excluded from this check by construction. That row's own
 * eventual fate is handled entirely by the PRE-EXISTING idempotency-key uniqueness constraint plus
 * each caller's own established "insert, and on a unique-constraint conflict, re-read and adopt the
 * existing row" pattern — this function never needs to (and must never) duplicate that handling; it
 * only ever rejects a GENUINELY DIFFERENT request (a different idempotency key) that finds another
 * still-financially-unresolved attempt already reserving this installment.
 */
export async function assertNoCompetingUnresolvedInstallmentAttemptWithinTx(
  tx: Tx,
  installmentScheduleItemId: string,
  excludeIdempotencyKey: string,
  /**
   * R11 TARGETED PROVIDER-RESERVATION CORRECTION: retry dispatch's own extra exclusion —
   * `failedPaymentRetryCoordinator.ts`'s `establishDurableDispatchIntent` passes the retry's OWN
   * `payment_retry.original_payment_attempt_id` here. A retry's own originating payment must NEVER be
   * able to block its own authorized retry, by identity, regardless of the EXACT status it happens to
   * carry at this instant — in the real production ordering it is always already terminal (`"failed"`)
   * before a retry is ever scheduled (`PaymentWebhookService` transitions status durably BEFORE
   * `handlePaymentFailed`/`coordinateFailure` ever runs), so this exclusion is normally redundant with
   * the status filter alone; it exists as a second, identity-based layer so this invariant never
   * depends on that ordering holding exactly, for this one specific, always-safe case. Every OTHER
   * caller (the ordinary provider-routed reserver, the manual/off-platform poster) has no such
   * "exempt by construction" row and passes nothing here.
   */
  excludePaymentAttemptId?: string,
): Promise<void> {
  const conditions = [
    eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId),
    ne(paymentAttempt.idempotencyKey, excludeIdempotencyKey),
    or(
      inArray(paymentAttempt.status, UNRESOLVED_PAYMENT_ATTEMPT_STATUSES),
      and(
        eq(paymentAttempt.status, "succeeded"),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(ledgerJournalEntry)
            .where(and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttempt.id), eq(ledgerJournalEntry.entryType, "payment_cleared"))),
        ),
      ),
    ),
  ];
  if (excludePaymentAttemptId) conditions.push(ne(paymentAttempt.id, excludePaymentAttemptId));
  const competing = await tx
    .select({ id: paymentAttempt.id })
    .from(paymentAttempt)
    .where(and(...conditions))
    .limit(1);
  if (competing[0]) {
    throw new ValidationError(
      "An unresolved payment attempt already exists for this installment. Wait for it to succeed, fail, or be canceled before starting a new one.",
    );
  }
}

/**
 * R11 CORRECTION PASS A (Defect A2 — INSTALLMENT MUST BELONG TO THE PAYMENT'S AGREEMENT): the prior
 * code accepted a caller-supplied, non-null `installmentScheduleItemId` on every ordinary
 * installment-linked payment-creation path without ever proving it belongs to the SAME agreement the
 * payment itself targets — a bare FK (`payment_attempt.installment_schedule_item_id` references
 * `installment_schedule_item.id`) proves the row EXISTS, never that it belongs to `agreementId`. This
 * closes that gap server-side: loads the installment's own `agreement_version_id`, resolves that
 * version's real `agreement_id`, and rejects (a) an installment that does not exist, (b) an
 * installment whose owning agreement differs from `agreementId` (a cross-agreement id), and (c) an
 * installment whose `agreement_version_id` is no longer the agreement's CURRENT version — the schema
 * scopes `installment_schedule_item` per `agreement_version` (`installmentScheduleItem
 * .agreementVersionId`, unique per `(agreementVersionId, sequenceNumber)`), and
 * `DrizzleInstallmentScheduleItemRepository.replaceForVersion` is called once per NEW agreement
 * version (see that repository's own doc comment and every amendment-service caller) — an
 * installment tied to a superseded version is a stale schedule, never payable directly.
 *
 * MUST be called AFTER the installment row is locked `FOR UPDATE` in the caller's own transaction
 * (mirrors every other R11 tx-bound check's own ordering requirement), and BEFORE any ceiling check
 * or insert. A plain (unlocked) read of `agreement.currentVersionId`/`agreementVersion.agreementId`
 * is sufficient here — neither field is ever mutated by any transaction this function could itself be
 * racing against the installment lock for (a signing/amendment transaction that COULD change
 * `agreement.currentVersionId` takes its own, entirely separate `agreement` row lock — see this
 * class's own top-level doc comment on lock ordering; this function never needs that same lock, only
 * a fresh read of the value).
 */
export async function assertInstallmentBelongsToAgreementWithinTx(tx: Tx, installmentScheduleItemId: string, agreementId: string): Promise<void> {
  const rows = await tx
    .select({
      installmentAgreementVersionId: installmentScheduleItem.agreementVersionId,
      versionAgreementId: agreementVersion.agreementId,
      agreementCurrentVersionId: agreement.currentVersionId,
    })
    .from(installmentScheduleItem)
    .innerJoin(agreementVersion, eq(agreementVersion.id, installmentScheduleItem.agreementVersionId))
    .innerJoin(agreement, eq(agreement.id, agreementVersion.agreementId))
    .where(eq(installmentScheduleItem.id, installmentScheduleItemId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ValidationError("Installment not found.");
  }
  if (row.versionAgreementId !== agreementId) {
    throw new ValidationError("This installment does not belong to the specified agreement.");
  }
  if (row.installmentAgreementVersionId !== row.agreementCurrentVersionId) {
    throw new ValidationError("This installment belongs to a superseded agreement schedule version and can no longer be paid directly.");
  }
}

/**
 * R11: the Postgres-backed counterpart to `computeInstallmentSettlement` — mirrors the exact shape
 * (and the exact reasons for that shape) of `computeRemainingBalanceMinorUnitsWithinTx`
 * (failedPaymentRetryCoordinator.ts) and `AgreementCompletionService.computeFreshEvidenceWithinTx`:
 * takes an already-open `tx`, never opens its own `getDb()` connection (the shared pool is `max: 1`
 * — calling anything bound to a separate connection from inside an already-open transaction on it
 * deadlocks). Joins `payment_attempt` to `ledger_journal_entry` via the immutable
 * `payment_attempt.installment_schedule_item_id` link (never an installment id stored on the ledger
 * entry itself — no such column exists, and R11's own design deliberately does not add one; see
 * `computeInstallmentSettlement`'s own doc comment for why Option A — this join — was the approved
 * architecture over adding a column or a separate allocation table).
 *
 * Does NOT itself acquire the installment row lock — every call site that needs the lock (every
 * mutation path) already acquires its own `SELECT ... FOR UPDATE` on `installment_schedule_item`
 * earlier in the same transaction (the existing, established pattern throughout
 * `failedPaymentRetryCoordinator.ts`/`agreementCompletionService.ts`); once that lock is held,
 * Postgres guarantees this function's own plain reads observe the locked, consistent state
 * regardless of which specific statement first acquired the lock. A read-only caller (e.g. the R11
 * historical-reconciliation sweep, or a caller merely displaying the authoritative remaining amount)
 * may call this with no lock held at all — the result is then a point-in-time snapshot, exactly like
 * `BalanceService.getAgreementBalance`'s own unlocked read.
 *
 * LOCK-ORDERING NOTE (found and fixed during R11's own concurrency hardening — see
 * `paymentWebhookRecovery.postgres.test.ts`'s "R-B40-STRICT-B" test for the full write-up): this
 * function's own reads never take a lock, but a CALLER that goes on to INSERT a new `payment_attempt`
 * row referencing this SAME `installmentScheduleItemId` must never do so while a DIFFERENT, still-open
 * transaction holds this installment row `FOR UPDATE` — Postgres takes an implicit FOR KEY SHARE lock
 * on the referenced row for that insert's own foreign-key check, which blocks until the FOR UPDATE
 * holder's transaction resolves. If that holder is itself waiting on application-level JS (not a DB
 * lock) that only proceeds once the insert completes, the result is a genuine deadlock Postgres's own
 * detector cannot see (one side of the cycle never touches the database at all). `ledger_journal_entry`/
 * `ledger_posting` carry no foreign key to `installment_schedule_item`, so writes to THOSE tables are
 * never subject to this — only a new `payment_attempt` row is.
 */
export async function computeInstallmentSettlementWithinTx(
  tx: Tx,
  installmentScheduleItemId: string,
): Promise<(InstallmentSettlementSnapshot & { dueDate: string; status: string }) | null> {
  const installmentRows = await tx
    .select({ amountMinorUnits: installmentScheduleItem.amountMinorUnits, dueDate: installmentScheduleItem.dueDate, status: installmentScheduleItem.status })
    .from(installmentScheduleItem)
    .where(eq(installmentScheduleItem.id, installmentScheduleItemId))
    .limit(1);
  const installmentRow = installmentRows[0];
  if (!installmentRow) return null;

  const attemptRows = await tx.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
  const attemptIds = attemptRows.map((r) => r.id);

  const entries: LedgerJournalEntryRecord[] = [];
  if (attemptIds.length > 0) {
    const entryRows = await tx.select().from(ledgerJournalEntry).where(inArray(ledgerJournalEntry.paymentAttemptId, attemptIds));
    for (const entryRow of entryRows) {
      const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
      entries.push({
        id: entryRow.id,
        entryType: entryRow.entryType,
        agreementId: entryRow.agreementId,
        paymentAttemptId: entryRow.paymentAttemptId,
        currency: entryRow.currency,
        reason: entryRow.reason,
        createdAt: entryRow.createdAt,
        postings: postingRows.map((p) => ({ id: p.id, accountId: p.accountId, accountType: p.accountType, direction: p.direction, amountMinorUnits: p.amountMinorUnits })),
      });
    }
  }

  const settlement = computeInstallmentSettlement({ id: installmentScheduleItemId, amountMinorUnits: installmentRow.amountMinorUnits }, entries);
  return { ...settlement, dueDate: installmentRow.dueDate, status: installmentRow.status };
}

/**
 * R11: does this agreement's CURRENT version have any installment schedule at all? The authoritative
 * predicate for "is this a scheduled agreement" — used by the new ordinary-payment linkage
 * requirement (R11 Final Open Issue A) to decide whether a non-null `installmentScheduleItemId` is
 * mandatory for a given payment creation. An agreement with zero installment_schedule_item rows for
 * its current version is unscheduled — an unlinked agreement-level payment remains valid for it under
 * the existing agreement-level rules (Architect-approved carve-out).
 */
export async function agreementHasInstallmentScheduleWithinTx(tx: Tx, agreementVersionId: string): Promise<boolean> {
  const rows = await tx.select({ id: installmentScheduleItem.id }).from(installmentScheduleItem).where(eq(installmentScheduleItem.agreementVersionId, agreementVersionId)).limit(1);
  return rows.length > 0;
}
