import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createFullLedgerTestContext } from "@/lib/ledger/integrationTestFakes";
import { createConfirmManualPaymentHandler } from "./route";

/** PRSprint 18: route-level coverage for POST /api/payments/manual/confirm. */
function postWithCookie(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/payments/manual/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/payments/manual/confirm", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let paymentId: string;
  let debtorToken: string;
  let creditorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    ctx = createFullLedgerTestContext();
    authCtx = createTestAuthService();

    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `confirm-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `confirm-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `confirm-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    debtorToken = debtor.token;
    creditorToken = creditor.token;
    strangerToken = stranger.token;

    const debtorProfileId = randomUUID();
    const creditorProfileId = randomUUID();
    ctx.paymentCtx.verificationCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);
    ctx.paymentCtx.verificationCtx.profileOwners.set("business", creditorProfileId, creditor.user.id);

    const agreement = await ctx.agreementRepo.insert({
      creditorProfileKind: "business",
      creditorProfileId,
      debtorProfileKind: "personal",
      debtorProfileId,
      currency: "USD",
      createdByUserId: debtor.user.id,
    });
    await ctx.agreementRepo.updateStatus(agreement.id, "first_payment_pending");
    ctx.paymentCtx.agreements.register(agreement.id, {
      creditor: { profileKind: "business", profileId: creditorProfileId },
      debtor: { profileKind: "personal", profileId: debtorProfileId },
    });
    ctx.balanceCtx.terms.set(agreement.id, 10_000, "USD");

    const record = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `confirm-seed-${randomUUID()}`,
      agreementId: agreement.id,
      amountMinorUnits: 2_000,
      actingUserId: debtor.user.id,
    });
    paymentId = record.id;
  });

  function handlerFor() {
    return withErrorHandling("payment_manual_confirm", createConfirmManualPaymentHandler(authCtx.authService, ctx.paymentCtx.paymentService));
  }

  it("lets the creditor (recipient) confirm the manual payment", async () => {
    const response = await handlerFor()(postWithCookie({ id: paymentId }, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { recipientConfirmedAt: string | null };
    expect(body.recipientConfirmedAt).not.toBeNull();
  });

  it("rejects the debtor confirming their own manual payment", async () => {
    const response = await handlerFor()(postWithCookie({ id: paymentId }, debtorToken));
    expect(response.status).toBe(403);
  });

  it("rejects a cross-tenant stranger", async () => {
    const response = await handlerFor()(postWithCookie({ id: paymentId }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ id: paymentId }));
    expect(response.status).toBe(401);
  });
});
