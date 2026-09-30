import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { createTestBalanceService, createTestLedgerService } from "./testFakes";

describe("BalanceService", () => {
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  const agreementId = randomUUID();

  beforeEach(() => {
    ledgerCtx = createTestLedgerService();
    balanceCtx = createTestBalanceService(ledgerCtx);
    balanceCtx.terms.set(agreementId, 10_000, "USD");
  });

  it("rejects a balance request for an agreement with no known principal", async () => {
    await expect(balanceCtx.balanceService.getAgreementBalance(randomUUID())).rejects.toThrow(ValidationError);
  });

  it("is 'unpaid' with no payments at all", async () => {
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.originalPrincipalMinorUnits).toBe(10_000);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.remainingBalanceMinorUnits).toBe(10_000);
    expect(balance.settlementState).toBe("unpaid");
  });

  it("is 'partially_paid' after one of several installments clears", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 4_000,
    });
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(4_000);
    expect(balance.remainingBalanceMinorUnits).toBe(6_000);
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("is 'paid_in_full' once cleared payments equal the principal exactly", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 4_000,
    });
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 6_000,
    });
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(10_000);
    expect(balance.remainingBalanceMinorUnits).toBe(0);
    expect(balance.settlementState).toBe("paid_in_full");
  });

  it("is 'overpaid' when cleared payments exceed the principal", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 12_000,
    });
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.settlementState).toBe("overpaid");
    expect(balance.remainingBalanceMinorUnits).toBe(-2_000);
  });

  it("excludes a reversed payment from amountPaid, whether reversed pre- or post-payout", async () => {
    const payment1 = randomUUID();
    const payment2 = randomUUID();
    await ledgerCtx.ledgerService.postPaymentCleared({ paymentAttemptId: payment1, agreementId, currency: "USD", grossAmountMinorUnits: 3_000 });
    await ledgerCtx.ledgerService.reversePayment({ paymentAttemptId: payment1, entryType: "refund", reason: "x" });

    await ledgerCtx.ledgerService.postPaymentCleared({ paymentAttemptId: payment2, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    await ledgerCtx.ledgerService.postPayout({ paymentAttemptId: payment2 });
    await ledgerCtx.ledgerService.reversePayment({ paymentAttemptId: payment2, entryType: "reversal", reason: "ACH return" });

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.reversedMinorUnits).toBe(3_000 + 5_000);
    expect(balance.remainingBalanceMinorUnits).toBe(10_000);
    expect(balance.settlementState).toBe("unpaid");
  });

  it("never mutates the underlying agreement principal it reads (requirement #7)", async () => {
    const before = await balanceCtx.terms.getPrincipal(agreementId);
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 4_000,
    });
    await balanceCtx.balanceService.getAgreementBalance(agreementId);
    const after = await balanceCtx.terms.getPrincipal(agreementId);
    expect(after).toEqual(before);
  });

  // Stage 4 (docs/remediation/ — settlement-balance defect remediation, corrected pass):
  // SET-FINAL-01 through SET-FINAL-04, plus SET-02/SET-03 as supporting "none"-resolution evidence.

  it("SET-FINAL-01: a completed settlement reports paid=cash, forgiven=effective amount, remaining=0, settled_in_full", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 6_000,
    });
    balanceCtx.settlementBalance.setEffectiveForgivenMinorUnits(agreementId, 4_000);

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(6_000);
    expect(balance.effectiveForgivenMinorUnits).toBe(4_000);
    expect(balance.remainingBalanceMinorUnits).toBe(0);
    expect(balance.settlementState).toBe("settled_in_full");
  });

  it("SET-FINAL-02: a failed settlement whose persisted consequence is forgive_permanently reduces the remaining obligation without fabricating a payment", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 2_000,
    });
    // Models DrizzleSettlementBalanceReader's own resolution for a failure_consequence_applied row
    // whose resolvedConsequence is "forgive_permanently": permanent forgiveness of 3,000, even though
    // the settlement itself never completed.
    balanceCtx.settlementBalance.setEffectiveForgivenMinorUnits(agreementId, 3_000);

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(2_000); // actual money only — never inflated by forgiveness.
    expect(balance.effectiveForgivenMinorUnits).toBe(3_000);
    expect(balance.remainingBalanceMinorUnits).toBe(5_000); // 10,000 - 2,000 - 3,000.
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("SET-FINAL-03: a failed settlement whose persisted consequence is restore_stated governs the resulting remaining balance directly, not the ordinary ledger-only figure", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 2_000,
    });
    // The ordinary ledger-only calculation would say remaining = 10,000 - 2,000 = 8,000 — but the
    // parties' own persisted restore_stated terms authoritatively say 7,500 instead (an arbitrary
    // agreed figure that need not decompose as principal-minus-anything).
    balanceCtx.settlementBalance.setRestoredRemainingBalanceMinorUnits(agreementId, 7_500);

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(2_000); // real cash is still reported accurately.
    expect(balance.effectiveForgivenMinorUnits).toBe(0); // this is an override, not forgiveness.
    expect(balance.remainingBalanceMinorUnits).toBe(7_500); // the authoritative resolved balance governs.
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("SET-FINAL-04 / SET-02: a settlement that has not completed (proposed/awaiting_payment) contributes zero forgiveness — normal balance behavior is unchanged", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 3_000,
    });
    // No settlementBalance call at all — mirrors DrizzleSettlementBalanceReader's real query, which
    // only ever resolves a "completed" or "failure_consequence_applied" row; a merely proposed/
    // awaiting_payment settlement is not represented here, exactly like production.

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.effectiveForgivenMinorUnits).toBe(0);
    expect(balance.amountPaidMinorUnits).toBe(3_000);
    expect(balance.remainingBalanceMinorUnits).toBe(7_000);
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("SET-03: a failed settlement with restore_original consequence leaves the balance exactly as the ledger already shows it (no forgiveness ever became effective)", async () => {
    // restore_original's own persisted rule (settlementService.ts's resolveFailureConsequence) is
    // `preSettlementBalance - totalCollected` — mathematically identical to this agreement's ordinary
    // ledger-derived remaining balance with zero forgiveness, since preSettlementBalance was itself
    // `principal - amountPaidAtProposalTime` and totalCollected is additional real cash already
    // reflected in amountPaidMinorUnits below. DrizzleSettlementBalanceReader resolves this exact case
    // to `{ kind: "none" }` (see that class's own doc comment) — proving effectiveForgivenMinorUnits
    // stays 0 is the exact, sufficient evidence that the restored obligation is not silently forgiven
    // or duplicated.
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 2_000,
    });

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.effectiveForgivenMinorUnits).toBe(0);
    expect(balance.amountPaidMinorUnits).toBe(2_000);
    expect(balance.remainingBalanceMinorUnits).toBe(8_000);
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("SET-04: a normal, non-settlement agreement's balance behavior is exactly unchanged", async () => {
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: randomUUID(),
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: 10_000,
    });

    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.effectiveForgivenMinorUnits).toBe(0);
    expect(balance.amountPaidMinorUnits).toBe(10_000);
    expect(balance.remainingBalanceMinorUnits).toBe(0);
    expect(balance.settlementState).toBe("paid_in_full");
  });

  it("REFUND-CORRECTION-BALANCE-01: payment_cleared -> refund -> refund_correction reconstructs to fully paid, with journal history intact", async () => {
    const paymentAttemptId = randomUUID();
    await ledgerCtx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
    await ledgerCtx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "initial refund" });
    await ledgerCtx.ledgerService.correctRefund({ paymentAttemptId, reason: "refund failed at the processor after initially succeeding" });

    // Journal history remains intact — every entry still present, none erased or rewritten.
    const entries = await ledgerCtx.ledgerService.listEntriesForPaymentAttempt(paymentAttemptId);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    expect(entries.filter((e) => e.entryType === "refund")).toHaveLength(1);
    expect(entries.filter((e) => e.entryType === "refund_correction")).toHaveLength(1);

    // Resulting economic balance treats the refund as undone: fully paid again, not reversed.
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(5_000);
    expect(balance.reversedMinorUnits).toBe(0);
    expect(balance.remainingBalanceMinorUnits).toBe(5_000); // agreementId's principal is 10,000 in this suite's beforeEach.
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("reconstructs the identical balance regardless of the order ledger entries are read in", async () => {
    const paymentIds = [randomUUID(), randomUUID(), randomUUID()];
    const amounts = [1_000, 2_500, 1_500];
    for (let i = 0; i < paymentIds.length; i += 1) {
      await ledgerCtx.ledgerService.postPaymentCleared({
        paymentAttemptId: paymentIds[i]!,
        agreementId,
        currency: "USD",
        grossAmountMinorUnits: amounts[i]!,
      });
    }

    const forward = await balanceCtx.balanceService.getAgreementBalance(agreementId);

    // Shuffle listForAgreement's return order and recompute directly to prove order-independence,
    // without relying on internal storage iteration order (requirement #16).
    const originalListForAgreement = ledgerCtx.entries.listForAgreement.bind(ledgerCtx.entries);
    ledgerCtx.entries.listForAgreement = async (id: string) => {
      const entries = await originalListForAgreement(id);
      return [...entries].reverse();
    };
    const reversedOrder = await balanceCtx.balanceService.getAgreementBalance(agreementId);

    expect(reversedOrder).toEqual(forward);
    expect(forward.amountPaidMinorUnits).toBe(1_000 + 2_500 + 1_500);
  });
});
