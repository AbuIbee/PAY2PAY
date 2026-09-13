import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, installmentScheduleItem, paymentAttempt } from "@/db/schema";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import {
  assertInstallmentBelongsToAgreementWithinTx,
  assertNoCompetingUnresolvedInstallmentAttemptWithinTx,
  computeInstallmentSettlementWithinTx,
} from "@/lib/ledger/installmentSettlementTx";
import type { InstallmentPaymentReserver, PaymentAttemptRecord } from "./paymentService";

/**
 * R11 CORRECTION PASS A (Defect A3 — AGREEMENT/INSTALLMENT DEADLOCK CYCLE): the same kind of
 * production-safe, no-op-by-default test-only affordance as `InstallmentLockTestHooks`
 * (`failedPaymentRetryCoordinator.ts`) / `AgreementLockTestHooks` (`drizzleSigningApplicationRepository.ts`)
 * — lets a `*.postgres.test.ts` suite deterministically pause this transaction the instant it
 * genuinely holds the NEW agreement row lock (see this class's own top-level doc comment for why that
 * lock was added and the exact lock order it now shares with `DrizzleAtomicManualPaymentPoster`),
 * long enough to prove a concurrently-racing operation on the same agreement/installment queues
 * behind it rather than crossing it out of order. Defaults to `undefined`; every production call site
 * (`new DrizzleInstallmentAwarePaymentReserver()`, no argument) never sets it.
 */
export interface InstallmentReservationTestHooks {
  /** Awaited immediately after the NEW agreement row lock has been GRANTED — before the installment row is ever locked. */
  afterAgreementLock?: () => Promise<void>;
  /**
   * R11 CORRECTION PASS A (TEST INFRASTRUCTURE REQUIREMENT — genuine independent-connection
   * concurrency): awaited immediately after the installment row lock has been GRANTED — before the
   * ownership check, the competing-unresolved-attempt check, or the insert. Lets a
   * `*.postgres.test.ts` suite deterministically prove a SECOND, genuinely independent connection's
   * own reservation attempt against the SAME installment is really blocked, server-side, behind this
   * held lock (via `waitUntilPidBlockedOnLock`), rather than merely racing two `Promise`s on one
   * shared, `max: 1`-pooled connection.
   */
  afterInstallmentLock?: () => Promise<void>;
}

type PaymentAttemptRow = typeof paymentAttempt.$inferSelect;

function toPaymentAttemptRecord(row: PaymentAttemptRow): PaymentAttemptRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    recipientProfileKind: row.recipientProfileKind,
    recipientProfileId: row.recipientProfileId,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    agreementId: row.agreementId,
    status: row.status,
    providerName: row.providerName,
    providerPaymentId: row.providerPaymentId,
    failureReason: row.failureReason,
    payoutCompletedAt: row.payoutCompletedAt,
    payoutInitiatedAt: row.payoutInitiatedAt,
    installmentScheduleItemId: row.installmentScheduleItemId,
    paymentMethod: row.paymentMethod,
    recordedByUserId: row.recordedByUserId,
    recipientConfirmedAt: row.recipientConfirmedAt,
    bankConnectionId: row.bankConnectionId,
    lifecycleCheckedAt: row.lifecycleCheckedAt,
    financialRepairNextAttemptAt: row.financialRepairNextAttemptAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * R11 (INSTALLMENT AMOUNT-AWARENESS — PAYMENT INITIATION CEILING): real implementation of
 * `InstallmentPaymentReserver` — see that interface's own doc comment in paymentService.ts. Mirrors
 * `DrizzleAtomicManualPaymentPoster`'s established "single, hand-written transaction, writing
 * directly against raw Drizzle table objects" pattern, narrowed to the installment ceiling rather
 * than the agreement-level one (the agreement-level `assertNotOverpaying` pre-check in
 * `PaymentService.reserveAttempt` runs BEFORE this is ever called, and is preserved unchanged — this
 * is an ADDITIONAL, narrower gate, never a replacement).
 *
 * R11 CORRECTION PASS A (Defect A3 — AGREEMENT/INSTALLMENT DEADLOCK CYCLE): this transaction now ALSO
 * locks the `agreement` row `FOR UPDATE`, FIRST — before the installment row — to match the SAME
 * `agreement -> installment -> payment_attempt/ledger writes` order `DrizzleAtomicManualPaymentPoster`
 * already used. Before this fix, this transaction locked ONLY the installment row and then, via its
 * own `payment_attempt` INSERT, took an IMPLICIT `FOR KEY SHARE` lock on the referenced `agreement`
 * row for that insert's own foreign-key check (see `computeInstallmentSettlementWithinTx`'s own
 * "LOCK-ORDERING NOTE") — an `installment -> agreement` micro-order exactly backwards from the manual
 * poster's `agreement -> installment` order, so a manual payment holding `agreement` and waiting on
 * `installment` could cross a provider reservation holding `installment` and (via its own insert)
 * waiting on `agreement` — a genuine lock-order cycle. Every transaction that needs both locks now
 * acquires them in the SAME order, so no such cycle can ever form (see `InstallmentReservationTestHooks`'s
 * own doc comment for the regression this proves).
 */
export class DrizzleInstallmentAwarePaymentReserver implements InstallmentPaymentReserver {
  /**
   * R11 CORRECTION PASS A: `db` is injectable (defaulting to the shared production singleton) so
   * `*.postgres.test.ts` concurrency suites can hand two instances of this class two genuinely
   * distinct PostgreSQL connections — mirrors `DrizzleAgreementRepository`'s identical precedent. Every
   * production call site (`new DrizzleInstallmentAwarePaymentReserver()`, no argument) is unaffected.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: InstallmentReservationTestHooks,
  ) {}

  async reserveWithinInstallmentCeiling(
    input: Parameters<InstallmentPaymentReserver["reserveWithinInstallmentCeiling"]>[0],
  ): ReturnType<InstallmentPaymentReserver["reserveWithinInstallmentCeiling"]> {
    const db = this.db;
    return db.transaction(async (tx) => {
      // R11 CORRECTION PASS A (Defect A3): agreement row lock FIRST — see this class's own top-level
      // doc comment for the exact lock-order cycle this closes.
      const agreementLockRows = await tx.select({ id: agreement.id }).from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (!agreementLockRows[0]) {
        throw new ValidationError("Agreement not found.");
      }
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();

      // Row lock on the target installment — the same serialization boundary every other R11 mutation
      // path uses (failedPaymentRetryCoordinator.ts, agreementCompletionService.ts). A second,
      // concurrent reservation attempt against the SAME installment blocks here until this
      // transaction commits or rolls back, then re-reads the now-current settlement below.
      const lockRows = await tx.select({ id: installmentScheduleItem.id }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId)).for("update").limit(1);
      if (!lockRows[0]) {
        throw new ValidationError("Installment not found.");
      }
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();

      // R11 CORRECTION PASS A (Defect A2): the target installment must genuinely belong to THIS
      // agreement's own CURRENT schedule — see `assertInstallmentBelongsToAgreementWithinTx`'s own doc
      // comment.
      await assertInstallmentBelongsToAgreementWithinTx(tx, input.installmentScheduleItemId, input.agreementId);

      // R11 TARGETED PROVIDER-RESERVATION CORRECTION: "at most one unresolved payment attempt per
      // installment" — see this function's own doc comment for exactly why the cleared-money ceiling
      // check alone cannot prevent two concurrent provider-routed reservations from both succeeding.
      // Excludes `input.idempotencyKey` itself, so a genuine duplicate submission of the SAME request
      // is never rejected here — it falls through to the pre-existing idempotency-key-conflict
      // handling around the insert below instead.
      await assertNoCompetingUnresolvedInstallmentAttemptWithinTx(tx, input.installmentScheduleItemId, input.idempotencyKey);

      const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      if (settlement && input.amountMinorUnits > settlement.remainingMinorUnits) {
        throw new ValidationError(
          `This payment of ${input.amountMinorUnits} minor units would exceed this installment's remaining amount of ${settlement.remainingMinorUnits} minor units. Overpayment against a single installment is not permitted.`,
        );
      }

      const [inserted] = await tx
        .insert(paymentAttempt)
        .values({
          idempotencyKey: input.idempotencyKey,
          payerProfileKind: input.payerProfileKind,
          payerProfileId: input.payerProfileId,
          recipientProfileKind: input.recipientProfileKind,
          recipientProfileId: input.recipientProfileId,
          amountMinorUnits: input.amountMinorUnits,
          currency: input.currency,
          agreementId: input.agreementId,
          providerName: input.providerName,
          installmentScheduleItemId: input.installmentScheduleItemId,
          status: input.initialStatus ?? "pending",
          paymentMethod: input.paymentMethod ?? null,
          bankConnectionId: input.bankConnectionId ?? null,
        })
        .returning();
      if (!inserted) throw new ConfigurationError("payment_attempt insert returned no row during installment-ceiling-aware reservation");
      return toPaymentAttemptRecord(inserted);
    });
  }
}
