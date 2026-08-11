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
