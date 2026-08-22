import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyError, ForbiddenError, ValidationError } from "@/lib/errors";
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

  it("PRSprint 17: rejects an unsafe integer amount (beyond Number.MAX_SAFE_INTEGER)", async () => {
    await markFullyVerified(PAYER.profileKind, PAYER.profileId);
    await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    await expect(
      ctx.paymentService.createPayment(baseInput({ amountMinorUnits: Number.MAX_SAFE_INTEGER + 2 })),
    ).rejects.toThrow(ValidationError);
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

  describe("schedulePayment / submitPending (Sprint 11 two-phase flow)", () => {
    beforeEach(async () => {
      await markFullyVerified(PAYER.profileKind, PAYER.profileId);
      await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
    });

    it("schedulePayment creates a 'scheduled' record without ever calling the provider", async () => {
      const record = await ctx.paymentService.schedulePayment(baseInput({ idempotencyKey: "sched-1" }));
      expect(record.status).toBe("scheduled");
      expect(record.providerPaymentId).toBeNull();
    });

    it("schedulePayment still runs the full idempotency/ownership/verification gate", async () => {
      await expect(
        ctx.paymentService.schedulePayment(baseInput({ idempotencyKey: "sched-2", actingUserId: OTHER_USER_ID })),
      ).rejects.toThrow(ForbiddenError);
    });

    it("submitPending transitions scheduled -> submitted -> processing and calls the provider", async () => {
      const scheduled = await ctx.paymentService.schedulePayment(baseInput({ idempotencyKey: "sched-3" }));
      const submitted = await ctx.paymentService.submitPending(scheduled.id, PAYER_USER_ID);
      expect(submitted.status).toBe("processing");
      expect(submitted.providerPaymentId).toBeTruthy();
    });

    it("submitPending rejects a payment that is not currently scheduled", async () => {
      const record = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "sched-4" }));
      await expect(ctx.paymentService.submitPending(record.id, PAYER_USER_ID)).rejects.toThrow(ValidationError);
    });

    it("cancelPayment cancels a scheduled payment locally, without calling the provider", async () => {
      const scheduled = await ctx.paymentService.schedulePayment(baseInput({ idempotencyKey: "sched-5" }));
      const originalCancel = ctx.provider.cancelPayment.bind(ctx.provider);
      ctx.provider.cancelPayment = async () => {
        throw new Error("must not be called for a scheduled (never-submitted) payment");
      };
      const canceled = await ctx.paymentService.cancelPayment(scheduled.id, PAYER_USER_ID);
      expect(canceled.status).toBe("canceled");
      ctx.provider.cancelPayment = originalCancel;
    });
  });

  describe("PRSprint 09: a payment linked to a real agreement must match its actual debtor/creditor", () => {
    const AGREEMENT_ID = "11111111-1111-1111-1111-111111111111";
    const OTHER_PROFILE = { profileKind: "personal" as ProfileKind, profileId: "unrelated-profile-1" };

    beforeEach(async () => {
      await markFullyVerified(PAYER.profileKind, PAYER.profileId);
      await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
      ctx.verificationCtx.profileOwners.set(OTHER_PROFILE.profileKind, OTHER_PROFILE.profileId, OTHER_USER_ID);
      await markFullyVerified(OTHER_PROFILE.profileKind, OTHER_PROFILE.profileId);
      ctx.agreements.register(AGREEMENT_ID, { creditor: RECIPIENT, debtor: PAYER });
    });

    it("succeeds when payer/recipient exactly match the agreement's debtor/creditor", async () => {
      const record = await ctx.paymentService.createPayment(baseInput({ agreementId: AGREEMENT_ID }));
      expect(record.status).toBe("pending");
      expect(record.agreementId).toBe(AGREEMENT_ID);
    });

    it("rejects a recipient that does not match the agreement's real creditor", async () => {
      await expect(
        ctx.paymentService.createPayment(baseInput({ agreementId: AGREEMENT_ID, recipient: OTHER_PROFILE })),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.paymentService.createPayment(baseInput({ agreementId: AGREEMENT_ID, recipient: OTHER_PROFILE })),
      ).rejects.toThrow(/must match this agreement's debtor and creditor/i);
      // No payment_attempt row was ever created for the rejected attempts.
      expect(await ctx.paymentService.listByAgreementId(AGREEMENT_ID)).toEqual([]);
    });

    it("rejects a payer that does not match the agreement's real debtor, even if they own that profile", async () => {
      await expect(
        ctx.paymentService.createPayment(
          baseInput({ agreementId: AGREEMENT_ID, payer: OTHER_PROFILE, actingUserId: OTHER_USER_ID }),
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it("does not enforce the check when the agreement id does not resolve to any real agreement", async () => {
      const record = await ctx.paymentService.createPayment(
        baseInput({ agreementId: "22222222-2222-2222-2222-222222222222", recipient: OTHER_PROFILE }),
      );
      expect(record.status).toBe("pending");
    });
  });

  describe("listByAgreementId (Sprint 18B Payments UI)", () => {
    it("returns only payment attempts for the given agreement, newest first", async () => {
      await markFullyVerified(PAYER.profileKind, PAYER.profileId);
      await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);

      const forAgreementA1 = await ctx.paymentService.createPayment(
        baseInput({ idempotencyKey: "agreement-a-1", agreementId: "agreement-a" }),
      );
      const forAgreementA2 = await ctx.paymentService.createPayment(
        baseInput({ idempotencyKey: "agreement-a-2", agreementId: "agreement-a" }),
      );
      await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "agreement-b-1", agreementId: "agreement-b" }));

      const results = await ctx.paymentService.listByAgreementId("agreement-a");
      expect(results.map((r) => r.id).sort()).toEqual([forAgreementA1.id, forAgreementA2.id].sort());
      expect(results.every((r) => r.agreementId === "agreement-a")).toBe(true);
    });

    it("returns an empty list for an agreement with no payment attempts", async () => {
      const results = await ctx.paymentService.listByAgreementId("no-such-agreement");
      expect(results).toEqual([]);
    });
  });

  describe(
    "PRSprint 29 (docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md): " +
      "paymentInitiationEnabled kill switch",
    () => {
      afterEach(() => {
        delete process.env.FEATURE_PAYMENT_INITIATION_ENABLED;
      });

      it("blocks a genuinely new payment when the switch is disabled", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        process.env.FEATURE_PAYMENT_INITIATION_ENABLED = "false";
        await expect(ctx.paymentService.createPayment(baseInput({ idempotencyKey: "kill-switch-1" }))).rejects.toThrow(
          DependencyError,
        );
      });

      it("still returns the existing record for a retried idempotency key even while the switch is disabled (never blocks a replay of an already-succeeded payment)", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        const original = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "kill-switch-2" }));

        process.env.FEATURE_PAYMENT_INITIATION_ENABLED = "false";
        const replay = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "kill-switch-2" }));
        expect(replay.id).toBe(original.id);
      });
    },
  );

  describe(
    "PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): transaction limits & review flagging",
    () => {
      afterEach(() => {
        delete process.env.MAX_PAYMENT_MINOR_UNITS;
        delete process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS;
      });

      it("rejects a single payment above the configured maximum", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        process.env.MAX_PAYMENT_MINOR_UNITS = "50000"; // $500
        await expect(ctx.paymentService.createPayment(baseInput({ idempotencyKey: "limit-1", amountMinorUnits: 60_000 }))).rejects.toThrow(
          ValidationError,
        );
      });

      it("allows a payment at or below the configured maximum", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        process.env.MAX_PAYMENT_MINOR_UNITS = "50000";
        const record = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "limit-2", amountMinorUnits: 50_000 }));
        expect(record.status).not.toBe("failed");
      });

      it("flags (but never blocks) a payment at or above the review threshold, via the existing audit log", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS = "10000"; // $100
        const record = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "review-1", amountMinorUnits: 15_000 }));
        expect(record.status).not.toBe("failed");
        const flags = ctx.auditRepo.events.filter((e) => e.action === "payment_flagged_for_review");
        expect(flags).toHaveLength(1);
      });

      it("does not flag a payment below the review threshold", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS = "10000";
        await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "review-2", amountMinorUnits: 5_000 }));
        const flags = ctx.auditRepo.events.filter((e) => e.action === "payment_flagged_for_review");
        expect(flags).toHaveLength(0);
      });

      it("never re-flags or re-validates a retried idempotency key against a limit set after the original succeeded", async () => {
        await markFullyVerified(PAYER.profileKind, PAYER.profileId);
        await markFullyVerified(RECIPIENT.profileKind, RECIPIENT.profileId);
        const original = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "limit-3", amountMinorUnits: 60_000 }));

        process.env.MAX_PAYMENT_MINOR_UNITS = "50000"; // now below the already-succeeded amount
        const replay = await ctx.paymentService.createPayment(baseInput({ idempotencyKey: "limit-3", amountMinorUnits: 60_000 }));
        expect(replay.id).toBe(original.id);
      });
    },
  );
});
