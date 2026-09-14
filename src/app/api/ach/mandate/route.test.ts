import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAchServices, seedAgreementForMandateTest } from "@/lib/ach/testFakes";
import { createAchMandateAuthorizeHandler } from "./route";
import { createAchMandateRevokeHandler } from "./revoke/route";

/**
 * PRSprint 23 (docs/prsprints/PRSPRINT_23_ACH_BANK_LINKING_RECONCILIATION.md): no route-level test
 * previously existed for any /api/ach/* route — AchMandateService's own authorization is already
 * thoroughly unit-tested (achMandateService.test.ts), but nothing previously proved the HTTP boundary
 * itself (unauthenticated / cross-tenant) for the two highest-risk actions: authorizing and revoking
 * a bank-debit mandate. Mirrors src/app/api/payments/manual/route.test.ts's established pattern.
 */
describe("POST /api/ach/mandate", () => {
  let ach: ReturnType<typeof createTestAchServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let ownerToken: string;
  let ownerUserId: string;
  let strangerToken: string;
  let ownerProfileId: string;

  beforeEach(async () => {
    ach = createTestAchServices();
    authCtx = createTestAuthService();

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `ach-mandate-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `ach-mandate-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    ownerUserId = owner.user.id;
    strangerToken = stranger.token;
    ownerProfileId = randomUUID();
    ach.paymentCtx.verificationCtx.profileOwners.set("personal", ownerProfileId, owner.user.id);
    // R08 B1: AchMandateService.authorize now requires the payer to be `authorizeBody.agreementId`'s
    // own persisted debtor (ACH-1 correction) — this suite's own authorization boundary under test is
    // profile ownership, not agreement-debtor binding, so it just seeds a matching agreement.
    seedAgreementForMandateTest(
      ach.agreements,
      authorizeBody.agreementId,
      { profileKind: "personal", profileId: ownerProfileId },
      { profileKind: "business", profileId: randomUUID() },
    );
  });

  function authorizeHandler() {
    return withErrorHandling("ach_mandate_authorize", createAchMandateAuthorizeHandler(authCtx.authService, ach.achMandateService));
  }

  function postAuthorize(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/ach/mandate", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  const authorizeBody = { agreementId: randomUUID(), payerProfileKind: "personal", payerProfileId: "", bankAccountRef: "sandbox_bank_1" };

  it("lets the profile owner authorize a mandate", async () => {
    const response = await authorizeHandler()(postAuthorize({ ...authorizeBody, payerProfileId: ownerProfileId }, ownerToken));
    expect(response.status).toBe(201);
  });

  it("rejects a stranger authorizing a mandate for someone else's profile", async () => {
    const response = await authorizeHandler()(postAuthorize({ ...authorizeBody, payerProfileId: ownerProfileId }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await authorizeHandler()(postAuthorize({ ...authorizeBody, payerProfileId: ownerProfileId }));
    expect(response.status).toBe(401);
  });

  describe("POST /api/ach/mandate/revoke", () => {
    function revokeHandler() {
      return withErrorHandling("ach_mandate_revoke", createAchMandateRevokeHandler(authCtx.authService, ach.achMandateService));
    }
    function postRevoke(body: unknown, token?: string) {
      return new NextRequest("http://localhost/api/ach/mandate/revoke", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
        body: JSON.stringify(body),
      });
    }

    it("rejects a stranger revoking someone else's mandate", async () => {
      const revokeTestAgreementId = randomUUID();
      // R08 B1: this direct authorize() call is only setup for the revoke test below, so it needs
      // its own seeded agreement matching ownerProfileId as debtor (see ACH-1 correction note above).
      seedAgreementForMandateTest(
        ach.agreements,
        revokeTestAgreementId,
        { profileKind: "personal", profileId: ownerProfileId },
        { profileKind: "business", profileId: randomUUID() },
      );
      const mandate = await ach.achMandateService.authorize({
        agreementId: revokeTestAgreementId,
        payer: { profileKind: "personal", profileId: ownerProfileId },
        bankAccountRef: "sandbox_bank_1",
        actingUserId: ownerUserId,
      });
      const response = await revokeHandler()(postRevoke({ mandateId: mandate.id, reason: "Not my mandate." }, strangerToken));
      expect(response.status).toBe(403);
    });

    it("rejects an unauthenticated request with 401", async () => {
      const response = await revokeHandler()(postRevoke({ mandateId: randomUUID(), reason: "test" }));
      expect(response.status).toBe(401);
    });
  });
});
