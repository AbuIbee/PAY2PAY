import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAchServices } from "@/lib/ach/testFakes";
import { createAchManualPaymentHandler } from "./route";

/**
 * Restore agreement payment functionality: this route previously dropped `installmentScheduleItemId`
 * silently even though AchPaymentService.createManualPayment has always accepted it — no client
 * could ever tag a manual payment as collecting a specific scheduled installment. Proves the field
 * now survives the HTTP boundary, since Step 5's "is there an open/failed attempt for the next-due
 * installment" logic depends entirely on it being set correctly.
 */
describe("POST /api/ach/payments/manual", () => {
  let ach: ReturnType<typeof createTestAchServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let payerToken: string;
  let payerProfileId: string;
  let recipientProfileId: string;
  let agreementId: string;
  let installmentId: string;

  beforeEach(async () => {
    ach = createTestAchServices();
    authCtx = createTestAuthService();

    const payer = await authCtx.authService.signup({
      email: `ach-manual-payer-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    payerToken = payer.token;
    payerProfileId = randomUUID();
    recipientProfileId = randomUUID();
    agreementId = randomUUID();
    installmentId = randomUUID();
    ach.paymentCtx.verificationCtx.profileOwners.set("personal", payerProfileId, payer.user.id);
    for (const profileId of [payerProfileId, recipientProfileId]) {
      await ach.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest("personal", profileId);
      await ach.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: "personal",
        profileId,
        decision: "verified",
        reviewerUserId: randomUUID(),
        reason: null,
      });
    }
    await ach.achMandateService.authorize({
      agreementId,
      payer: { profileKind: "personal", profileId: payerProfileId },
      bankAccountRef: "sandbox_bank_1",
      actingUserId: payer.user.id,
    });
  });

  function handler() {
    return withErrorHandling("ach_payment_manual", createAchManualPaymentHandler(authCtx.authService, ach.achPaymentService));
  }

  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/ach/payments/manual", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("carries installmentScheduleItemId through to the created payment attempt", async () => {
    const response = await handler()(
      post(
        {
          idempotencyKey: randomUUID(),
          agreementId,
          payer: { profileKind: "personal", profileId: payerProfileId },
          recipient: { profileKind: "personal", profileId: recipientProfileId },
          amountMinorUnits: 5_000,
          currency: "USD",
          installmentScheduleItemId: installmentId,
        },
        payerToken,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    const record = await ach.paymentCtx.payments.findById(body.id);
    expect(record?.installmentScheduleItemId).toBe(installmentId);
  });

  it("still works with no installmentScheduleItemId (off-schedule manual payment)", async () => {
    const response = await handler()(
      post(
        {
          idempotencyKey: randomUUID(),
          agreementId,
          payer: { profileKind: "personal", profileId: payerProfileId },
          recipient: { profileKind: "personal", profileId: recipientProfileId },
          amountMinorUnits: 5_000,
          currency: "USD",
        },
        payerToken,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    const record = await ach.paymentCtx.payments.findById(body.id);
    expect(record?.installmentScheduleItemId).toBeNull();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(
      post({
        idempotencyKey: randomUUID(),
        agreementId,
        payer: { profileKind: "personal", profileId: payerProfileId },
        recipient: { profileKind: "personal", profileId: recipientProfileId },
        amountMinorUnits: 5_000,
        currency: "USD",
      }),
    );
    expect(response.status).toBe(401);
  });
});
