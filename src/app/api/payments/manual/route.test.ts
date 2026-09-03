import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createFullLedgerTestContext } from "@/lib/ledger/integrationTestFakes";
import { createManualPaymentHandler } from "./route";

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md):
 * route-level coverage for POST /api/payments/manual, mirroring
 * src/app/api/payments/detail/route.test.ts's established pattern. PaymentService.
 * recordManualOffPlatformPayment already has unit-level coverage
 * (src/lib/ledger/paymentLedgerIntegration.test.ts) — this exercises the route boundary.
 */
function postWithCookie(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/payments/manual", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/payments/manual", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementId: string;
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
      email: `manual-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `manual-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `manual-stranger-${randomUUID()}@example.com`,
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
    agreementId = agreement.id;
    ctx.paymentCtx.agreements.register(agreementId, {
      creditor: { profileKind: "business", profileId: creditorProfileId },
      debtor: { profileKind: "personal", profileId: debtorProfileId },
    });
    ctx.balanceCtx.terms.set(agreementId, 10_000, "USD");
  });

  function handlerFor() {
    return withErrorHandling("payment_manual_record", createManualPaymentHandler(authCtx.authService, ctx.paymentCtx.paymentService));
  }

  it("lets the debtor record a manual off-platform payment", async () => {
    const response = await handlerFor()(
      postWithCookie({ idempotencyKey: `route-manual-${randomUUID()}`, agreementId, amountMinorUnits: 2_000 }, debtorToken),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("succeeded");
  });

  it("rejects the creditor recording their own manual payment — only the debtor may", async () => {
    const response = await handlerFor()(
      postWithCookie({ idempotencyKey: `route-manual-${randomUUID()}`, agreementId, amountMinorUnits: 2_000 }, creditorToken),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a cross-tenant stranger", async () => {
    const response = await handlerFor()(
      postWithCookie({ idempotencyKey: `route-manual-${randomUUID()}`, agreementId, amountMinorUnits: 2_000 }, strangerToken),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ idempotencyKey: `route-manual-${randomUUID()}`, agreementId, amountMinorUnits: 2_000 }));
    expect(response.status).toBe(401);
  });

  it("rejects an amount that exceeds the remaining balance", async () => {
    const response = await handlerFor()(
      postWithCookie({ idempotencyKey: `route-manual-${randomUUID()}`, agreementId, amountMinorUnits: 20_000 }, debtorToken),
    );
    expect(response.status).toBe(400);
  });
});
