import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestPaymentService } from "./testFakes";
import type { ProfileKind } from "./paymentProvider";

const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";
const OTHER_USER_ID = "other-user-1";
const PAYER = { profileKind: "personal" as ProfileKind, profileId: "payer-profile-1" };
const RECIPIENT = { profileKind: "business" as ProfileKind, profileId: "recipient-profile-1" };

describe("PaymentService", () => {
  let ctx: ReturnType<typeof createTestPaymentService>;

  beforeEach(async () => {
    ctx = createTestPaymentService();
    ctx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ctx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
  });

  async function markFullyVerified(profileKind: ProfileKind, profileId: string): Promise<void> {
    await ctx.verificationCtx.verificationService.submitFullVerificationRequest(profileKind, profileId);
    await ctx.verificationCtx.verificationService.recordManualVerificationDecision({
      profileKind,
      profileId,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: null,
    });
  }

  function baseInput(overrides: Partial<Parameters<typeof ctx.paymentService.createPayment>[0]> = {}) {
    return {
      idempotencyKey: "idem-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 10_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
      ipAddress: "127.0.0.1",
      deviceInfo: null,
      ...overrides,
    };
  }

  it("blocks payment creation when the payer is not FULL_VERIFIED, even if the recipient is", async () => {
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    await expect(ctx.paymentService.createPayment(baseInput())).rejects.toThrow(ValidationError);
    await expect(ctx.paymentService.createPayment(baseInput())).rejects.toThrow(/payer must complete identity verification/i);
  });

  it("blocks payment creation when the recipient is not FULL_VERIFIED, even if the payer is", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await expect(ctx.paymentService.createPayment(baseInput())).rejects.toThrow(ValidationError);
    await expect(ctx.paymentService.createPayment(baseInput())).rejects.toThrow(/recipient must complete identity verification/i);
  });

  it("creates a pending payment once both payer and recipient are FULL_VERIFIED", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    const record = await ctx.paymentService.createPayment(baseInput());
    expect(record.status).toBe("pending");
    expect(record.providerName).toBe("sandbox_mock");
    expect(record.providerPaymentId).toBeTruthy();
  });

  it("rejects creating a payment for a payer profile the caller does not own", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    await expect(
      ctx.paymentService.createPayment(baseInput({ actingUserId: OTHER_USER_ID })),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a non-positive or non-integer amount", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    await expect(ctx.paymentService.createPayment(baseInput({ amountMinorUnits: 0 }))).rejects.toThrow(ValidationError);
    await expect(ctx.paymentService.createPayment(baseInput({ amountMinorUnits: 10.5 }))).rejects.toThrow(ValidationError);
  });

  it("is idempotent: the same idempotency key returns the same record without a second provider call", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    const first = await ctx.paymentService.createPayment(baseInput());
    const second = await ctx.paymentService.createPayment(baseInput());
    expect(second.id).toBe(first.id);
    expect(await ctx.payments.findById(first.id)).not.toBeNull();
  });

  it("marks the payment failed and surfaces a safe error when the provider fails synchronously", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    const originalCreatePayment = ctx.provider.createPayment.bind(ctx.provider);
    ctx.provider.createPayment = async () => {
      throw new Error("sandbox_processor_unavailable");
    };
    await expect(ctx.paymentService.createPayment(baseInput({ idempotencyKey: "idem-fail" }))).rejects.toThrow(
      ValidationError,
    );
    ctx.provider.createPayment = originalCreatePayment;

    const failed = await ctx.payments.findByIdempotencyKey("idem-fail");
    expect(failed?.status).toBe("failed");
    expect(failed?.failureReason).toContain("sandbox_processor_unavailable");
  });

  describe("retrieve/cancel/refund authorization", () => {
    beforeEach(async () => {
      await markFullyVerified(PAYER.profileKind, PAYER.profileId);
      await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    });

    it("lets the payer or the recipient retrieve the payment, and no one else", async () => {
      const record = await ctx.paymentService.createPayment(baseInput());
      await expect(ctx.paymentService.retrievePayment(record.id, PAYER_USER_ID)).resolves.toMatchObject({ id: record.id });
      await expect(ctx.paymentService.retrievePayment(record.id, RECIPIENT_USER_ID)).resolves.toMatchObject({ id: record.id });
      await expect(ctx.paymentService.retrievePayment(record.id, OTHER_USER_ID)).rejects.toThrow(ForbiddenError);
    });

    it("cancels only while pending", async () => {
      const record = await ctx.paymentService.createPayment(baseInput());
      const canceled = await ctx.paymentService.cancelPayment(record.id, PAYER_USER_ID);
      expect(canceled.status).toBe("canceled");
      await expect(ctx.paymentService.cancelPayment(record.id, PAYER_USER_ID)).rejects.toThrow(ValidationError);
    });

    it("refunds only a succeeded payment, and only for the recipient", async () => {
      // Force an immediate-succeeded provider outcome for this test by monkey-patching createPayment once.
      const originalCreatePayment = ctx.provider.createPayment.bind(ctx.provider);
      ctx.provider.createPayment = (input) => originalCreatePayment({ ...input, simulateOutcome: "succeeded" });
      const record = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "idem-refund" }));
      ctx.provider.createPayment = originalCreatePayment;
      expect(record.status).toBe("succeeded");

      await expect(ctx.paymentService.refundPayment(record.id, PAYER_USER_ID)).rejects.toThrow(ForbiddenError);
      const refunded = await ctx.paymentService.refundPayment(record.id, RECIPIENT_USER_ID);
      expect(refunded.status).toBe("refunded");
    });

    it("rejects refunding a still-pending payment", async () => {
      const record = await ctx.paymentService.createPayment(baseInput());
      await expect(ctx.paymentService.refundPayment(record.id, RECIPIENT_USER_ID)).rejects.toThrow(ValidationError);
    });
  });
});
