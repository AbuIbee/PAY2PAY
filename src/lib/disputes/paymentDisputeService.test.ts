import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestPaymentDisputeService } from "./testFakes";

describe("PaymentDisputeService", () => {
  let ctx: ReturnType<typeof createTestPaymentDisputeService>;
  let agreementId: string;
  let payerProfileId: string;
  let payerUserId: string;
  let recipientProfileId: string;

  beforeEach(() => {
    ctx = createTestPaymentDisputeService();
    agreementId = randomUUID();
    payerProfileId = randomUUID();
    payerUserId = randomUUID();
    recipientProfileId = randomUUID();
    ctx.paymentCtx.verificationCtx.profileOwners.set("personal", payerProfileId, payerUserId);
    ctx.terms.set(agreementId, 100_000);
  });

  async function seedClearedPayment(paymentMethod: "ach" | "debit_card", amountMinorUnits = 20_000) {
    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `payment-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId,
      recipientProfileKind: "personal",
      recipientProfileId,
      amountMinorUnits,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
      paymentMethod,
    });
    await ctx.ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: attempt.id,
      agreementId,
      currency: "USD",
      grossAmountMinorUnits: amountMinorUnits,
    });
    return attempt;
  }

  describe("payment dispute", () => {
    it("claiming: the payer can claim a succeeded payment as unauthorized, preserving mandate/signature/identity-verification references and IP/device", async () => {
      const attempt = await seedClearedPayment("ach");
      ctx.mandatesAndSignatures.setMandateReference(agreementId, "ach_mandate:preserved-1");
      ctx.mandatesAndSignatures.setSignatureReference(agreementId, "personal", payerProfileId, "signature_event:preserved-1");
      ctx.identityVerifications.setIdentityVerificationReference("personal", payerProfileId, "identity_verification_record:preserved-1");

      const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_ach",
        explanation: "I never authorized this debit.",
        actingUserId: payerUserId,
        ipAddress: "203.0.113.5",
        deviceInfo: { userAgent: "test-agent" },
      });

      expect(dispute.status).toBe("claimed");
      expect(dispute.preservedMandateReference).toBe("ach_mandate:preserved-1");
      expect(dispute.preservedSignatureReference).toBe("signature_event:preserved-1");
      expect(dispute.preservedIdentityVerificationReference).toBe("identity_verification_record:preserved-1");
      expect(dispute.ipAddress).toBe("203.0.113.5");
      expect(dispute.deviceInfo).toEqual({ userAgent: "test-agent" });

      const updatedPayment = await ctx.paymentCtx.payments.findById(attempt.id);
      expect(updatedPayment?.status).toBe("disputed");
    });

    it("rejects a category/payment-method mismatch (unauthorized_debit_card claimed against an ACH payment)", async () => {
      const attempt = await seedClearedPayment("ach");
      await expect(
        ctx.paymentDisputeService.claimUnauthorizedPayment({
          paymentAttemptId: attempt.id,
          category: "unauthorized_debit_card",
          explanation: "x",
          actingUserId: payerUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects claiming a payment that has not succeeded", async () => {
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `payment-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId,
        recipientProfileKind: "personal",
        recipientProfileId,
        amountMinorUnits: 20_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "processing",
      });
      await expect(
        ctx.paymentDisputeService.claimUnauthorizedPayment({
          paymentAttemptId: attempt.id,
          category: "processor_dispute",
          explanation: "x",
          actingUserId: payerUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("recordProcessorOutcome upheld: refunds the payment (Disputed --> Refunded: claim upheld)", async () => {
      const attempt = await seedClearedPayment("debit_card");
      const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_debit_card",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      const resolved = await ctx.paymentDisputeService.recordProcessorOutcome({
        paymentDisputeId: dispute.id,
        outcome: "upheld",
        actingUserId: randomUUID(),
        actingRole: "platform_admin",
        resolutionNotes: "Processor confirmed the charge was unauthorized.",
      });
      expect(resolved.status).toBe("upheld");
      const updatedPayment = await ctx.paymentCtx.payments.findById(attempt.id);
      expect(updatedPayment?.status).toBe("refunded");
    });

    it("recordProcessorOutcome denied: reinstates the payment as succeeded (Disputed --> PaidOut: claim denied, payment stands)", async () => {
      const attempt = await seedClearedPayment("ach");
      const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_ach",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      const resolved = await ctx.paymentDisputeService.recordProcessorOutcome({
        paymentDisputeId: dispute.id,
        outcome: "denied",
        actingUserId: randomUUID(),
        actingRole: "platform_admin",
      });
      expect(resolved.status).toBe("denied");
      const updatedPayment = await ctx.paymentCtx.payments.findById(attempt.id);
      expect(updatedPayment?.status).toBe("succeeded");
    });
  });

  describe("permissions", () => {
    it("only the payer may claim a payment as unauthorized", async () => {
      const attempt = await seedClearedPayment("ach");
      const outsiderUserId = randomUUID();
      await expect(
        ctx.paymentDisputeService.claimUnauthorizedPayment({
          paymentAttemptId: attempt.id,
          category: "unauthorized_ach",
          explanation: "x",
          actingUserId: outsiderUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("recordProcessorOutcome requires Platform Admin/Owner — never the payer themselves", async () => {
      const attempt = await seedClearedPayment("ach");
      const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_ach",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });
      await expect(
        ctx.paymentDisputeService.recordProcessorOutcome({
          paymentDisputeId: dispute.id,
          outcome: "upheld",
          actingUserId: payerUserId,
          actingRole: "member",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("reversal impact / balance update", () => {
    it("a claimed dispute immediately excludes the payment from the agreement's paid balance and counts it as reversed", async () => {
      const attempt = await seedClearedPayment("ach", 20_000);
      const before = await ctx.balanceService.getAgreementBalance(agreementId);
      expect(before.amountPaidMinorUnits).toBe(20_000);
      expect(before.reversedMinorUnits).toBe(0);

      await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_ach",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      const after = await ctx.balanceService.getAgreementBalance(agreementId);
      expect(after.amountPaidMinorUnits).toBe(0);
      expect(after.reversedMinorUnits).toBe(20_000);
      expect(after.remainingBalanceMinorUnits).toBe(100_000);
    });

    it("upholding the claim keeps the payment excluded from the paid balance (refund is also a reversal-shaped ledger entry)", async () => {
      const attempt = await seedClearedPayment("ach", 20_000);
      const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: attempt.id,
        category: "unauthorized_ach",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });
      await ctx.paymentDisputeService.recordProcessorOutcome({
        paymentDisputeId: dispute.id,
        outcome: "upheld",
        actingUserId: randomUUID(),
        actingRole: "platform_admin",
      });

      const balance = await ctx.balanceService.getAgreementBalance(agreementId);
      expect(balance.amountPaidMinorUnits).toBe(0);
      expect(balance.reversedMinorUnits).toBe(20_000);
    });

    it("other cleared payments on the same agreement are unaffected by a dispute on one payment", async () => {
      const disputed = await seedClearedPayment("ach", 20_000);
      const unrelated = await seedClearedPayment("debit_card", 30_000);
      await ctx.paymentDisputeService.claimUnauthorizedPayment({
        paymentAttemptId: disputed.id,
        category: "unauthorized_ach",
        explanation: "x",
        actingUserId: payerUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      const balance = await ctx.balanceService.getAgreementBalance(agreementId);
      expect(balance.amountPaidMinorUnits).toBe(30_000);
      expect(balance.reversedMinorUnits).toBe(20_000);
      expect(unrelated.id).not.toBe(disputed.id);
    });
  });

  it("audits the claim and the outcome", async () => {
    const attempt = await seedClearedPayment("ach");
    const dispute = await ctx.paymentDisputeService.claimUnauthorizedPayment({
      paymentAttemptId: attempt.id,
      category: "unauthorized_ach",
      explanation: "x",
      actingUserId: payerUserId,
      ipAddress: null,
      deviceInfo: null,
    });
    await ctx.paymentDisputeService.recordProcessorOutcome({
      paymentDisputeId: dispute.id,
      outcome: "denied",
      actingUserId: randomUUID(),
      actingRole: "platform_owner",
    });

    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual(["payment_dispute_claimed", "payment_dispute_denied"]);
    const outcomeEvent = ctx.auditRepo.events.find((e) => e.action === "payment_dispute_denied");
    expect(outcomeEvent?.actorRole).toBe("platform_owner");
  });
});
