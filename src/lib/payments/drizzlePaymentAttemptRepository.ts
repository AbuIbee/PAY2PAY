import "server-only";
import { and, asc, desc, eq, exists, gte, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, ledgerJournalEntry, paymentAttempt } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentAttemptStatus, PaymentMethod } from "./paymentService";
import type { ProfileRef } from "./paymentProvider";

type Row = typeof paymentAttempt.$inferSelect;

function toRecord(row: Row): PaymentAttemptRecord {
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

export class DrizzlePaymentAttemptRepository implements PaymentAttemptRepository {
  /**
   * R09 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct PostgreSQL
   * connection, proving real overlap/contention for `updateStatusIfNotTerminal` — a single shared
   * `max: 1` connection structurally cannot exhibit that. Every production call site
   * (`new DrizzlePaymentAttemptRepository()`, no argument) is unaffected.
   */
  constructor(private readonly db: Database = getDb()) {}

  async insertPending(input: {
    idempotencyKey: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    recipientProfileKind: "personal" | "business";
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    agreementId: string | null;
    providerName: string;
    installmentScheduleItemId?: string | null;
    initialStatus?: PaymentAttemptStatus;
    paymentMethod?: PaymentMethod | null;
    recordedByUserId?: string | null;
    bankConnectionId?: string | null;
  }): Promise<PaymentAttemptRecord> {
    const db = this.db;
    const { initialStatus, ...rest } = input;
    const [row] = await db
      .insert(paymentAttempt)
      .values({ ...rest, status: initialStatus ?? "pending" })
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt insert returned no row");
    return toRecord(row);
  }

  async updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord> {
    const db = this.db;
    const [row] = await db
      .update(paymentAttempt)
      .set({ status, updatedAt: new Date(), ...fields })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt update returned no row");
    return toRecord(row);
  }

  /**
   * R09 corrective pass — see `PaymentAttemptRepository.updateStatusIfLegalTransition`'s own doc
   * comment for the exact race and illegal-regression this closes. One atomic `UPDATE ... WHERE id =
   * ? AND status IN (...)`, never a separate read then a blind write — `.returning()` coming back
   * empty is how Postgres tells us the row's current status was not an allowed source for this
   * destination (or the row didn't exist), the same convention every other conditional-update pattern
   * in this codebase uses (e.g. `AgreementRepository.updateStatusIfCurrentlyIn`).
   */
  async updateStatusIfLegalTransition(
    id: string,
    newStatus: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
    allowedSourceStatuses: readonly PaymentAttemptStatus[],
  ): Promise<PaymentAttemptRecord | null> {
    const db = this.db;
    const rows = await db
      .update(paymentAttempt)
      .set({ status: newStatus, updatedAt: new Date(), ...fields })
      .where(and(eq(paymentAttempt.id, id), inArray(paymentAttempt.status, [...allowedSourceStatuses])))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async confirmManualPayment(id: string, confirmedAt: Date): Promise<PaymentAttemptRecord> {
    const db = this.db;
    const [row] = await db
      .update(paymentAttempt)
      .set({ recipientConfirmedAt: confirmedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt confirmManualPayment found no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<PaymentAttemptRecord | null> {
    const db = this.db;
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null> {
    const db = this.db;
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null> {
    const db = this.db;
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.providerPaymentId, providerPaymentId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markPayoutCompleted(id: string, payoutCompletedAt: Date): Promise<PaymentAttemptRecord> {
    const db = this.db;
    const [row] = await db
      .update(paymentAttempt)
      .set({ payoutCompletedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt markPayoutCompleted found no row");
    return toRecord(row);
  }

  async markPayoutInitiated(id: string, payoutInitiatedAt: Date): Promise<PaymentAttemptRecord> {
    const db = this.db;
    const [row] = await db
      .update(paymentAttempt)
      .set({ payoutInitiatedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt markPayoutInitiated found no row");
    return toRecord(row);
  }

  async findOpenByInstallment(installmentScheduleItemId: string): Promise<PaymentAttemptRecord | null> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId),
          inArray(paymentAttempt.status, ["pending", "scheduled", "submitted", "processing"]),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db.select().from(paymentAttempt);
    return rows.map(toRecord);
  }

  async listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.agreementId, agreementId))
      .orderBy(desc(paymentAttempt.createdAt));
    return rows.map(toRecord);
  }

  async listRecentByPayer(payer: ProfileRef, sinceDate: Date): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.payerProfileKind, payer.profileKind),
          eq(paymentAttempt.payerProfileId, payer.profileId),
          gte(paymentAttempt.createdAt, sinceDate),
        ),
      );
    return rows.map(toRecord);
  }

  /**
   * R09 corrective pass (Codex blocker 1) — bounded, indexed candidate query for the scheduler's
   * automatic ledger/lifecycle repair path (`payment_attempt_status_updated_at_idx`). Never an
   * unbounded scan: callers must page via repeated bounded calls if they need more than `limit`.
   */
  async listRecentlySucceeded(limit: number): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.status, "succeeded"))
      .orderBy(desc(paymentAttempt.updatedAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * PACKAGE B — remaining Codex blockers (Section 1 — automatic repair must be bounded AND
   * eventually complete). Every "succeeded" payment with NO existing `payment_cleared` ledger entry
   * — a genuinely unresolved candidate, not merely "recently touched". Oldest-updated first
   * (`payment_attempt_status_updated_at_idx` covers the leading `status` predicate; `updated_at ASC,
   * id ASC` gives a deterministic, starvation-free order). Once a row's `payment_cleared` entry is
   * posted, it drops out of this query's `NOT EXISTS` entirely — repeatedly calling this with a
   * bounded `limit` is therefore guaranteed to eventually cover every genuinely unresolved row,
   * without needing a separate durable cursor: the pool of rows that still match shrinks every time
   * one is repaired, so no fixed newest-first ordering can ever starve an older one out forever.
   */
  async listMissingClearingCandidates(limit: number, now: Date): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.status, "succeeded"),
          or(isNull(paymentAttempt.financialRepairNextAttemptAt), lte(paymentAttempt.financialRepairNextAttemptAt, now)),
          notExists(
            db
              .select({ one: sql`1` })
              .from(ledgerJournalEntry)
              .where(
                and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttempt.id), eq(ledgerJournalEntry.entryType, "payment_cleared")),
              ),
          ),
        ),
      )
      .orderBy(asc(paymentAttempt.updatedAt), asc(paymentAttempt.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * PACKAGE B — remaining Codex blockers (Section 1): every "succeeded" payment whose agreement has
   * NOT YET reached a converged/terminal state — the bounded candidate set for the "payment + ledger
   * both correct, agreement lifecycle simply never advanced" shape `listMissingClearingCandidates`
   * cannot see (its ledger entry already exists, so it never even LOOKS like a repair candidate to
   * that query). Calling `AgreementCompletionService.checkAndAdvance` for every one of these is safe
   * and idempotent by construction — it only actually advances an agreement whose balance genuinely
   * indicates completion, so including an agreement that's legitimately still mid-schedule is a
   * harmless no-op, never a false advancement. Self-shrinking once the agreement reaches
   * `paid_in_full` (drops out of the `IN (...)` predicate), same starvation-free ordering.
   */
  /**
   * See `listLifecycleRepairCandidates`'s interface doc comment (paymentService.ts) for why
   * `lifecycleCheckedAt IS NULL` — not merely agreement status — is required for this to be
   * self-shrinking/starvation-free.
   *
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4 — B4 fix): also requires the
   * payment's OWN `payment_cleared` ledger entry to already exist. Without this, a payment whose
   * ledger entry is missing (a `listMissingClearingCandidates` concern, gated by its own backoff) could
   * ALSO surface here — a query with NO backoff awareness of its own — letting `repairBatch`'s merged
   * candidate set attempt (or even prematurely succeed at) a lifecycle advance for a payment whose
   * financial repair is still correctly blocked/deferred, and letting up to `limit` such ledger-less
   * rows monopolize this query's own bounded batch, starving a later payment that already has a valid
   * ledger entry and genuinely only needs its lifecycle effect examined. This makes the two candidate
   * sets semantically independent, as Codex's own finding requires.
   */
  async listLifecycleRepairCandidates(limit: number): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const rows = await db
      .select({ paymentAttempt })
      .from(paymentAttempt)
      .innerJoin(agreement, eq(agreement.id, paymentAttempt.agreementId))
      .where(
        and(
          eq(paymentAttempt.status, "succeeded"),
          inArray(agreement.status, ["first_payment_pending", "active", "past_due"]),
          isNull(paymentAttempt.lifecycleCheckedAt),
          exists(
            db
              .select({ one: sql`1` })
              .from(ledgerJournalEntry)
              .where(and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttempt.id), eq(ledgerJournalEntry.entryType, "payment_cleared"))),
          ),
        ),
      )
      .orderBy(asc(paymentAttempt.updatedAt), asc(paymentAttempt.id))
      .limit(limit);
    return rows.map((row) => toRecord(row.paymentAttempt));
  }

  async markLifecycleChecked(id: string, checkedAt: Date): Promise<void> {
    const db = this.db;
    await db.update(paymentAttempt).set({ lifecycleCheckedAt: checkedAt }).where(eq(paymentAttempt.id, id));
  }

  /**
   * The reversal-side counterpart to `listMissingClearingCandidates` — every refunded/returned/
   * reversed/disputed payment missing its OWN required reversal-type ledger entry (refund/reversal/
   * dispute_adjustment respectively, per the existing ledger state machine). Same starvation-free,
   * self-shrinking query shape and ordering.
   */
  async listMissingReversalCandidates(limit: number, now: Date): Promise<PaymentAttemptRecord[]> {
    const db = this.db;
    const missingEntryOfType = (entryType: "refund" | "reversal" | "dispute_adjustment") =>
      notExists(
        db
          .select({ one: sql`1` })
          .from(ledgerJournalEntry)
          .where(and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttempt.id), eq(ledgerJournalEntry.entryType, entryType))),
      );
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          or(isNull(paymentAttempt.financialRepairNextAttemptAt), lte(paymentAttempt.financialRepairNextAttemptAt, now)),
          or(
            and(eq(paymentAttempt.status, "refunded"), missingEntryOfType("refund")),
            and(eq(paymentAttempt.status, "returned"), missingEntryOfType("reversal")),
            and(eq(paymentAttempt.status, "reversed"), missingEntryOfType("reversal")),
            and(eq(paymentAttempt.status, "disputed"), missingEntryOfType("dispute_adjustment")),
          ),
        ),
      )
      .orderBy(asc(paymentAttempt.updatedAt), asc(paymentAttempt.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async markFinancialRepairDeferred(id: string, nextAttemptAt: Date): Promise<void> {
    const db = this.db;
    await db.update(paymentAttempt).set({ financialRepairNextAttemptAt: nextAttemptAt }).where(eq(paymentAttempt.id, id));
  }
}
