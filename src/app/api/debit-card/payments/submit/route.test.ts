import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestDebitCardServices, TEST_FUTURE_CARD_EXPIRY } from "@/lib/debitCard/testFakes";
import { createDebitCardSubmitHandler } from "./route";

/**
 * SPRINT_19_FraudRisk_SecurityHardening (P0): mirrors src/app/api/ach/payments/submit/route.test.ts —
 * this route previously had no per-payment authorization at all — PaymentService.submitPending
 * accepted any authenticated caller for any payment id, so a stranger who knew/guessed a scheduled
 * payment's id could force it to submit to the provider early. Fixed in PaymentService.
 * getAuthorizedRecord's new "payer_only" mode; this proves the HTTP boundary itself.
 */
describe("POST /api/debit-card/payments/submit", () => {
  let card: ReturnType<typeof createTestDebitCardServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let ownerToken: string;
  let ownerUserId: string;
  let strangerToken: string;
  const PAYER_PROFILE = { profileKind: "personal" as const, profileId: randomUUID() };
  const RECIPIENT_PROFILE = { profileKind: "business" as const, profileId: randomUUID() };
  const REVIEWER_USER_ID = "reviewer-1";
  const agreementId = randomUUID();
  let scheduledId: string;

  beforeEach(async () => {
    card = createTestDebitCardServices();
    card.feeAllocation.set(agreementId, "debtor_pays");
    authCtx = createTestAuthService();

    const owner = await authCtx.authService.signup({
      email: `card-submit-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: `card-submit-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    ownerUserId = owner.user.id;
    strangerToken = stranger.token;

    card.paymentCtx.verificationCtx.profileOwners.set(PAYER_PROFILE.profileKind, PAYER_PROFILE.profileId, ownerUserId);
    card.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT_PROFILE.profileKind, RECIPIENT_PROFILE.profileId, "recipient-user-1");
    for (const ref of [PAYER_PROFILE, RECIPIENT_PROFILE]) {
      await card.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await card.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
    await card.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER_PROFILE,
      cardToken: "sandbox_pm_1",
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: ownerUserId,
    });
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: `route-test-${randomUUID()}`,
      installmentScheduleItemId: randomUUID(),
      agreementId,
      payer: PAYER_PROFILE,
      recipient: RECIPIENT_PROFILE,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: ownerUserId,
    });
    scheduledId = scheduled.id;
  });

  function handler() {
    return withErrorHandling("debit_card_payment_submit", createDebitCardSubmitHandler(authCtx.authService, card.debitCardPaymentService));
  }

  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/debit-card/payments/submit", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("lets the payer submit their own scheduled payment", async () => {
    const response = await handler()(post({ id: scheduledId }, ownerToken));
    expect(response.status).toBe(200);
  });

  it("rejects a stranger submitting someone else's scheduled payment (P0 fix)", async () => {
    const response = await handler()(post({ id: scheduledId }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(post({ id: scheduledId }));
    expect(response.status).toBe(401);
  });
});
