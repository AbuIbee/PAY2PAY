import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, ConflictError, ValidationError } from "@/lib/errors";
import { createTestLedgerService } from "./testFakes";

describe("LedgerService", () => {
  let ctx: ReturnType<typeof createTestLedgerService>;
  const agreementId = randomUUID();
  const paymentAttemptId = randomUUID();

  beforeEach(() => {
    ctx = createTestLedgerService();
  });

  describe("postPaymentCleared", () => {
    it("posts a balanced entry: gross debit to processor_clearing, net credit to creditor_proceeds_payable", async () => {
      const entry = await ctx.ledgerService.postPaymentCleared({
        paymentAttemptId,
        agreementId,
        currency: "USD",
        grossAmountMinorUnits: 10_000,
      });
      expect(entry.entryType).toBe("payment_cleared");
      const debitTotal = entry.postings.filter((p) => p.direction === "debit").reduce((s, p) => s + p.amountMinorUnits, 0);
      const creditTotal = entry.postings.filter((p) => p.direction === "credit").reduce((s, p) => s + p.amountMinorUnits, 0);
      expect(debitTotal).toBe(creditTotal); // balance invariant
      expect(debitTotal).toBe(10_000);
      expect(entry.postings.find((p) => p.accountType === "processor_clearing")?.amountMinorUnits).toBe(10_000);
      expect(entry.postings.find((p) => p.accountType === "creditor_proceeds_payable")?.amountMinorUnits).toBe(10_000);
    });

    it("splits processor fee and platform fee into their own postings, still balanced", async () => {
      const entry = await ctx.ledgerService.postPaymentCleared({
        paymentAttemptId,
        agreementId,
        currency: "USD",
        grossAmountMinorUnits: 10_200,
        processorFeeMinorUnits: 150,
        platformFeeMinorUnits: 50,
      });
      const byType = Object.fromEntries(entry.postings.map((p) => [p.accountType, p.amountMinorUnits]));
      expect(byType.processor_clearing).toBe(10_200);
      expect(byType.processor_fee_expense).toBe(150);
      expect(byType.platform_fee_revenue).toBe(50);
      expect(byType.creditor_proceeds_payable).toBe(10_000);
      const debitTotal = entry.postings.filter((p) => p.direction === "debit").reduce((s, p) => s + p.amountMinorUnits, 0);
      const creditTotal = entry.postings.filter((p) => p.direction === "credit").reduce((s, p) => s + p.amountMinorUnits, 0);
      expect(debitTotal).toBe(creditTotal);
    });

    it("is idempotent: a second call for the same payment returns the existing entry rather than posting again", async () => {
      const first = await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
      const second = await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 5_000 });
      expect(second.id).toBe(first.id);
      const all = await ctx.ledgerService.listEntriesForPaymentAttempt(paymentAttemptId);
      expect(all.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    });

    it("rejects when fees exceed the gross amount", async () => {
      await expect(
        ctx.ledgerService.postPaymentCleared({
          paymentAttemptId,
          agreementId,
          currency: "USD",
          grossAmountMinorUnits: 100,
          processorFeeMinorUnits: 60,
          platformFeeMinorUnits: 60,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a zero or non-integer gross amount (integer-money invariant)", async () => {
      await expect(
        ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 0 }),
      ).rejects.toThrow(ValidationError);
      await expect(
        ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 10.5 }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("reversePayment", () => {
    async function clear(): Promise<void> {
      await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 10_000 });
    }

    it("rejects reversing a payment that never cleared", async () => {
      await expect(
        ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "test" }),
      ).rejects.toThrow(ValidationError);
    });

    it("pre-payout: mirrors every leg of the clear entry with the opposite direction (full reversal)", async () => {
      await clear();
      const refund = await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "buyer request" });
      expect(refund.entryType).toBe("refund");
      const debitTotal = refund.postings.filter((p) => p.direction === "debit").reduce((s, p) => s + p.amountMinorUnits, 0);
      const creditTotal = refund.postings.filter((p) => p.direction === "credit").reduce((s, p) => s + p.amountMinorUnits, 0);
      expect(debitTotal).toBe(creditTotal);
      expect(refund.postings.find((p) => p.accountType === "processor_clearing")?.direction).toBe("credit");
      expect(refund.postings.find((p) => p.accountType === "creditor_proceeds_payable")?.direction).toBe("debit");
    });

    it("post-payout: claws back only the creditor's net portion via creditor_clawback_exposure, not the full gross", async () => {
      await clear();
      await ctx.ledgerService.postPayout({ paymentAttemptId });
      const reversal = await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "reversal", reason: "ACH return" });
      expect(reversal.entryType).toBe("reversal");
      const clawback = reversal.postings.find((p) => p.accountType === "creditor_clawback_exposure");
      expect(clawback?.direction).toBe("debit");
      expect(clawback?.amountMinorUnits).toBe(10_000);
      expect(reversal.postings.find((p) => p.accountType === "processor_clearing")?.direction).toBe("credit");
    });

    it("is idempotent per entry type: a duplicate refund event does not double-post", async () => {
      await clear();
      const first = await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "a" });
      const second = await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "a" });
      expect(second.id).toBe(first.id);
    });

    it("refund and reversal and dispute_adjustment are independently distinguishable entry types", async () => {
      await clear();
      const dispute = await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "dispute_adjustment", reason: "opened" });
      expect(dispute.entryType).toBe("dispute_adjustment");
    });
  });

  describe("postPayout", () => {
    it("moves the creditor's net proceeds from creditor_proceeds_payable to processor_clearing", async () => {
      await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 8_000 });
      const payout = await ctx.ledgerService.postPayout({ paymentAttemptId });
      expect(payout.entryType).toBe("payout");
      expect(payout.postings.find((p) => p.accountType === "creditor_proceeds_payable")?.direction).toBe("debit");
      expect(payout.postings.find((p) => p.accountType === "processor_clearing")?.direction).toBe("credit");
    });

    it("rejects paying out a payment that has not cleared", async () => {
      await expect(ctx.ledgerService.postPayout({ paymentAttemptId })).rejects.toThrow(ValidationError);
    });

    it("rejects paying out a payment that has already been refunded", async () => {
      await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 1_000 });
      await ctx.ledgerService.reversePayment({ paymentAttemptId, entryType: "refund", reason: "x" });
      await expect(ctx.ledgerService.postPayout({ paymentAttemptId })).rejects.toThrow(ValidationError);
    });

    it("is idempotent: a second payout call returns the existing entry", async () => {
      await ctx.ledgerService.postPaymentCleared({ paymentAttemptId, agreementId, currency: "USD", grossAmountMinorUnits: 2_000 });
      const first = await ctx.ledgerService.postPayout({ paymentAttemptId });
      const second = await ctx.ledgerService.postPayout({ paymentAttemptId });
      expect(second.id).toBe(first.id);
    });
  });

  describe("postAdminAdjustment", () => {
    it("posts a balanced correction against the suspense account, requires a reason", async () => {
      await expect(
        ctx.ledgerService.postAdminAdjustment({
          paymentAttemptId,
          agreementId,
          currency: "USD",
          targetAccountType: "platform_fee_revenue",
          direction: "credit",
          amountMinorUnits: 500,
          reason: "",
          actingUserId: "owner-1",
        }),
      ).rejects.toThrow(ValidationError);

      const entry = await ctx.ledgerService.postAdminAdjustment({
        paymentAttemptId,
        agreementId,
        currency: "USD",
        targetAccountType: "platform_fee_revenue",
        direction: "credit",
        amountMinorUnits: 500,
        reason: "Manual correction for a mis-recorded fee.",
        actingUserId: "owner-1",
      });
      expect(entry.entryType).toBe("admin_adjustment");
      expect(entry.postings.find((p) => p.accountType === "admin_adjustment_suspense")?.direction).toBe("debit");
      const debitTotal = entry.postings.filter((p) => p.direction === "debit").reduce((s, p) => s + p.amountMinorUnits, 0);
      const creditTotal = entry.postings.filter((p) => p.direction === "credit").reduce((s, p) => s + p.amountMinorUnits, 0);
      expect(debitTotal).toBe(creditTotal);
    });

    it("allows at most one admin adjustment per payment", async () => {
      await ctx.ledgerService.postAdminAdjustment({
        paymentAttemptId,
        agreementId,
        currency: "USD",
        targetAccountType: "platform_fee_revenue",
        direction: "credit",
        amountMinorUnits: 100,
        reason: "first",
        actingUserId: "owner-1",
      });
      await expect(
        ctx.ledgerService.postAdminAdjustment({
          paymentAttemptId,
          agreementId,
          currency: "USD",
          targetAccountType: "platform_fee_revenue",
          direction: "credit",
          amountMinorUnits: 100,
          reason: "second",
          actingUserId: "owner-1",
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("audits with the acting user id and platform_owner role", async () => {
      await ctx.ledgerService.postAdminAdjustment({
        paymentAttemptId,
        agreementId,
        currency: "USD",
        targetAccountType: "platform_fee_revenue",
        direction: "credit",
        amountMinorUnits: 100,
        reason: "test",
        actingUserId: "owner-1",
      });
      const event = ctx.auditRepo.events.find((e) => e.action === "ledger_admin_adjustment");
      expect(event?.actorUserId).toBe("owner-1");
      expect(event?.actorRole).toBe("platform_owner");
      expect(event?.reason).toBe("test");
    });
  });

  it("assertBalanced throws ConfigurationError for an unbalanced posting set (would indicate a bug, not user input)", () => {
    expect(() =>
      ctx.ledgerService.assertBalanced([
        { accountId: "a", accountType: "processor_clearing", direction: "debit", amountMinorUnits: 100 },
        { accountId: "b", accountType: "creditor_proceeds_payable", direction: "credit", amountMinorUnits: 90 },
      ]),
    ).toThrow(ConfigurationError);
  });

  it("append-only by construction: LedgerJournalEntryRepository has no update/delete method for a posted entry", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.entries));
    expect(methodNames).not.toContain("update");
    expect(methodNames).not.toContain("delete");
    expect(methodNames).not.toContain("remove");
  });
});
