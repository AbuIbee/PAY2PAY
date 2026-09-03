import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { ProfileKind } from "@/lib/payments/paymentProvider";
import { createPaymentDetailHandler } from "./route";

/**
 * PRSprint 02 (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md): route-level cross-tenant/
 * IDOR coverage for GET /api/payments/detail, mirroring src/app/api/agreements/detail/route.test.ts.
 * PaymentService.retrievePayment already has unit-level stranger-rejection coverage
 * (src/lib/payments/paymentService.test.ts), but nothing previously exercised the route boundary.
 */
function getWithCookie(paymentId: string | null, token?: string) {
  const url = paymentId ? `http://localhost/api/payments/detail?id=${paymentId}` : "http://localhost/api/payments/detail";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/payments/detail", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let paymentCtx: ReturnType<typeof createTestPaymentService>;
  let paymentId: string;
  let payerToken: string;
  let recipientToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    paymentCtx = createTestPaymentService();

    const payer = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "pay-detail-payer@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const recipient = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "pay-detail-recipient@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "pay-detail-stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    payerToken = payer.token;
    recipientToken = recipient.token;
    strangerToken = stranger.token;

    const payerProfileId = randomUUID();
    const recipientProfileId = randomUUID();
    paymentCtx.verificationCtx.profileOwners.set("personal" as ProfileKind, payerProfileId, payer.user.id);
    paymentCtx.verificationCtx.profileOwners.set("business" as ProfileKind, recipientProfileId, recipient.user.id);

    const record = await paymentCtx.payments.insertPending({
      idempotencyKey: `route-test-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId,
      recipientProfileKind: "business",
      recipientProfileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: null,
      providerName: "sandbox_mock",
    });
    paymentId = record.id;
  });

  function handlerFor() {
    return withErrorHandling("payment_detail", createPaymentDetailHandler(authCtx.authService, paymentCtx.paymentService));
  }

  it("lets the payer fetch the payment", async () => {
    const response = await handlerFor()(getWithCookie(paymentId, payerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(paymentId);
  });

  it("lets the recipient fetch the payment", async () => {
    const response = await handlerFor()(getWithCookie(paymentId, recipientToken));
    expect(response.status).toBe(200);
  });

  it("rejects a cross-tenant IDOR attempt: an authenticated stranger cannot fetch someone else's payment by id", async () => {
    const response = await handlerFor()(getWithCookie(paymentId, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie(paymentId));
    expect(response.status).toBe(401);
  });
});
