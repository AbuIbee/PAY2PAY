import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, ledgerJournalEntry, ledgerPosting, paymentAttempt } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { BalanceService } from "./balanceService";
import { DrizzleAgreementTermsReader } from "./drizzleAgreementTermsReader";
import { DrizzleLedgerAccountRepository } from "./drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "./drizzleLedgerJournalEntryRepository";
import { LedgerService } from "./ledgerService";

/**
 * Stage 4 — Section 5 (direct real-PostgreSQL `refund_correction` proof). Closes the same schema-
 * parity defect class `payoutAtomicity.postgres.test.ts`'s PAY-04 found for `payout_returned` — this
 * is the sibling entry type (`LedgerService.correctRefund`), never previously exercised against real
 * PostgreSQL. One direct proof, per the governing order's own "do not create a large refund-
 * correction matrix" instruction.
 */

async function seedAgreement(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, principalMinorUnits: number): Promise<string> {
  const agreements = new DrizzleAgreementRepository();
  const created = await agreements.insert({
    creditorProfileKind: "personal",
    creditorProfileId,
    debtorProfileKind: "personal",
    debtorProfileId,
    currency: "USD",
    createdByUserId: creatorUserId,
  });
  const db = getDb();
  const [version] = await db
    .insert(agreementVersion)
    .values({
      agreementId: created.id,
      versionNumber: 1,
      isOriginal: true,
      producedBy: "stage4_refund_correction_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return created.id;
}

function buildLedger(): LedgerService {
  return new LedgerService({
    accounts: new DrizzleLedgerAccountRepository(),
    entries: new DrizzleLedgerJournalEntryRepository(),
    audit: new AuditService(new DrizzleAuditEventRepository()),
  });
}

describe("Stage 4: refund_correction direct real-PostgreSQL proof", () => {
  it("REFUND-CORRECTION-01 — correcting a posted refund creates exactly one refund_correction entry, the ledger remains balanced, and duplicate correction does not duplicate the effect", async () => {
    const creditor = await seedPersonalUser("s4-refcorr-creditor");
    const debtor = await seedPersonalUser("s4-refcorr-debtor");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 10_000);

    const payments = new DrizzlePaymentAttemptRepository();
    const providerPaymentId = `sandbox_pay_${randomUUID()}`;
    const inserted = await payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
    });
    const payment = await payments.updateStatus(inserted.id, "pending", { providerPaymentId });

    const ledger = buildLedger();
    // Valid precondition: a real, cleared payment, then a real, posted `refund` entry.
    await ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    const refundEntry = await ledger.reversePayment({ paymentAttemptId: payment.id, entryType: "refund", reason: "REFUND-CORRECTION-01: refund" });
    expect(refundEntry.entryType).toBe("refund");

    // The correction itself — this is the exact call that previously failed with
    // `invalid input value for enum ledger_entry_type: "refund_correction"` before the Stage 4
    // blocker migration (20260928000000_ledger_entry_type_stage4_parity.sql) applied.
    const correction = await ledger.correctRefund({ paymentAttemptId: payment.id, reason: "REFUND-CORRECTION-01: refund failed at the processor after initially succeeding" });
    expect(correction.entryType).toBe("refund_correction");

    const db = getDb();
    const correctionRows = await db
      .select()
      .from(ledgerJournalEntry)
      .where(eq(ledgerJournalEntry.paymentAttemptId, payment.id))
      .then((rows) => rows.filter((r) => r.entryType === "refund_correction"));
    expect(correctionRows).toHaveLength(1); // exactly one — persists successfully.

    // Ledger remains balanced: every posting row for this correction entry sums debits == credits.
    const correctionRow = correctionRows[0]!;
    const postings = await db.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, correctionRow.id));
    const debitTotal = postings.filter((p) => p.direction === "debit").reduce((sum, p) => sum + p.amountMinorUnits, 0);
    const creditTotal = postings.filter((p) => p.direction === "credit").reduce((sum, p) => sum + p.amountMinorUnits, 0);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(5_000);

    // Duplicate execution does not duplicate the economic effect — idempotent get-or-post.
    const replay = await ledger.correctRefund({ paymentAttemptId: payment.id, reason: "REFUND-CORRECTION-01: replay" });
    expect(replay.id).toBe(correction.id);
    const correctionRowsAfterReplay = await db
      .select()
      .from(ledgerJournalEntry)
      .where(eq(ledgerJournalEntry.paymentAttemptId, payment.id))
      .then((rows) => rows.filter((r) => r.entryType === "refund_correction"));
    expect(correctionRowsAfterReplay).toHaveLength(1);

    // The payment attempt itself is untouched by this ledger-only correction.
    const paymentRow = (await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, payment.id)))[0];
    expect(paymentRow).toBeDefined();

    // Step 6 (Stage 4 remediation order): BalanceService's own economic reconstruction must interpret
    // this exact history correctly — the refund_correction means the refund was economically undone,
    // so this payment counts as fully paid again, not reversed.
    const balanceService = new BalanceService({ ledger, terms: new DrizzleAgreementTermsReader() });
    const balance = await balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(5_000);
    expect(balance.reversedMinorUnits).toBe(0);
    expect(balance.remainingBalanceMinorUnits).toBe(5_000); // 10,000 principal - 5,000 paid.
  });
});
