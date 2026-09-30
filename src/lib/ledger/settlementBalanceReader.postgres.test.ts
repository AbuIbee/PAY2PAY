import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, settlementProposal } from "@/db/schema";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { BalanceService } from "@/lib/ledger/balanceService";
import { DrizzleAgreementTermsReader } from "@/lib/ledger/drizzleAgreementTermsReader";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { DrizzleSettlementBalanceReader } from "@/lib/ledger/drizzleSettlementBalanceReader";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";

/**
 * Stage 4 — Step 4's own explicit requirement: at least one settlement-balance test must exercise the
 * real, persisted PostgreSQL settlement reader (`DrizzleSettlementBalanceReader`), not only the
 * in-memory fake. Seeds real `settlement_proposal` rows directly (bypassing `SettlementService`'s full
 * negotiation workflow, which is not what this reader's own query logic depends on) for each of the
 * three non-"none" resolution kinds, then proves both the reader directly and the full
 * `BalanceService.getAgreementBalance` path end-to-end.
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
      producedBy: "stage4_settlement_balance_reader_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return created.id;
}

function baseSettlementRow(agreementId: string, creditorProfileId: string) {
  return {
    agreementId,
    proposingPartyRole: "creditor" as const,
    proposedByProfileKind: "personal" as const,
    proposedByProfileId: creditorProfileId,
    preSettlementBalanceMinorUnits: 10_000,
    settlementAmountMinorUnits: 6_000,
    forgivenAmountMinorUnits: 4_000,
    deadline: "2020-01-01",
    paymentMode: "one_time" as const,
  };
}

function buildBalanceService(): BalanceService {
  return new BalanceService({
    ledger: new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) }),
    terms: new DrizzleAgreementTermsReader(),
    settlementBalance: new DrizzleSettlementBalanceReader(),
  });
}

describe("Stage 4: real-PostgreSQL settlement balance reader proof", () => {
  it("SETTLEMENT-READER-01 — a real completed settlement_proposal row resolves to forgiveness, end-to-end through BalanceService", async () => {
    const creditor = await seedPersonalUser("s4-setreader-creditor-1");
    const debtor = await seedPersonalUser("s4-setreader-debtor-1");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 10_000);
    const db = getDb();
    await db.insert(settlementProposal).values({
      ...baseSettlementRow(agreementId, creditor.profileId),
      status: "completed",
      failureConsequence: "restore_original",
      completedAt: new Date(),
    });
    // A genuinely completed settlement (per SettlementService.recordSettlementPayment's own real
    // business rule) is only ever reached once the debtor has actually paid the settlement amount
    // (6,000 here) — seed that real cash payment too, so this scenario matches how "completed" is
    // ever actually reached in production, not an inconsistent state no real code path produces.
    const payments = new DrizzlePaymentAttemptRepository();
    const inserted = await payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 6_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
    });
    const payment = await payments.updateStatus(inserted.id, "pending", { providerPaymentId: `sandbox_pay_${randomUUID()}` });
    const ledger = new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) });
    await ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 6_000 });

    const reader = new DrizzleSettlementBalanceReader();
    const resolution = await reader.getSettlementBalanceResolution(agreementId);
    expect(resolution).toEqual({ kind: "forgiveness", effectiveForgivenMinorUnits: 4_000 });

    const balanceService = buildBalanceService();
    const balance = await balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(6_000);
    expect(balance.effectiveForgivenMinorUnits).toBe(4_000);
    expect(balance.remainingBalanceMinorUnits).toBe(0); // 10,000 - 6,000 paid - 4,000 forgiven.
    expect(balance.settlementState).toBe("settled_in_full");
  });

  it("SETTLEMENT-READER-02 — a real failed settlement_proposal row with forgive_permanently resolves to forgiveness using the resolved amount", async () => {
    const creditor = await seedPersonalUser("s4-setreader-creditor-2");
    const debtor = await seedPersonalUser("s4-setreader-debtor-2");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 10_000);
    const db = getDb();
    await db.insert(settlementProposal).values({
      ...baseSettlementRow(agreementId, creditor.profileId),
      status: "failure_consequence_applied",
      failureConsequence: "forgive_permanently",
      failureConsequenceStatedAmountMinorUnits: 3_000,
      resolvedConsequence: "forgive_permanently",
      resolvedForgivenAmountMinorUnits: 3_000,
      resolvedAt: new Date(),
    });

    const reader = new DrizzleSettlementBalanceReader();
    const resolution = await reader.getSettlementBalanceResolution(agreementId);
    expect(resolution).toEqual({ kind: "forgiveness", effectiveForgivenMinorUnits: 3_000 });

    const balanceService = buildBalanceService();
    const balance = await balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.effectiveForgivenMinorUnits).toBe(3_000);
    expect(balance.remainingBalanceMinorUnits).toBe(7_000); // 10,000 - 0 paid - 3,000 forgiven.
  });

  it("SETTLEMENT-READER-03 — a real failed settlement_proposal row with restore_stated resolves to the authoritative restored balance, overriding the ordinary calculation", async () => {
    const creditor = await seedPersonalUser("s4-setreader-creditor-3");
    const debtor = await seedPersonalUser("s4-setreader-debtor-3");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 10_000);
    const db = getDb();
    await db.insert(settlementProposal).values({
      ...baseSettlementRow(agreementId, creditor.profileId),
      status: "failure_consequence_applied",
      failureConsequence: "restore_stated",
      failureConsequenceStatedAmountMinorUnits: 7_500,
      resolvedConsequence: "restore_stated",
      resolvedRestoredBalanceMinorUnits: 7_500,
      resolvedAt: new Date(),
    });

    const reader = new DrizzleSettlementBalanceReader();
    const resolution = await reader.getSettlementBalanceResolution(agreementId);
    expect(resolution).toEqual({ kind: "restoredBalance", restoredRemainingBalanceMinorUnits: 7_500 });

    const balanceService = buildBalanceService();
    const balance = await balanceService.getAgreementBalance(agreementId);
    expect(balance.effectiveForgivenMinorUnits).toBe(0); // an override, not forgiveness.
    expect(balance.remainingBalanceMinorUnits).toBe(7_500); // the persisted resolved balance governs directly.
  });

  it("SETTLEMENT-READER-04 — no settlement_proposal row at all resolves to none, exactly like normal agreement balance behavior", async () => {
    const creditor = await seedPersonalUser("s4-setreader-creditor-4");
    const debtor = await seedPersonalUser("s4-setreader-debtor-4");
    const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, 10_000);

    const reader = new DrizzleSettlementBalanceReader();
    const resolution = await reader.getSettlementBalanceResolution(agreementId);
    expect(resolution).toEqual({ kind: "none" });
  });
});
