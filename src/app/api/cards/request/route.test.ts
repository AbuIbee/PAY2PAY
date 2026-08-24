import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestCardServices } from "@/lib/cards/testFakes";
import { createCardRequestHandler } from "./route";
import { createCardActivateHandler } from "../activate/route";
import { createCardFreezeHandler } from "../freeze/route";
import { createCardCancelHandler } from "../cancel/route";

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): route-level
 * coverage for the card-issuance API — CardService's own authorization/lifecycle rules are already
 * thoroughly unit-tested (cardService.test.ts); this exercises the HTTP boundary (unauthenticated /
 * cross-tenant) for the request, activate, freeze, and cancel actions.
 */
describe("POST /api/cards/*", () => {
  let ctx: ReturnType<typeof createTestCardServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let ownerToken: string;
  let strangerToken: string;
  let ownerProfileId: string;

  beforeEach(async () => {
    ctx = createTestCardServices();
    authCtx = createTestAuthService();

    const owner = await authCtx.authService.signup({
      email: `card-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: `card-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    strangerToken = stranger.token;
    ownerProfileId = randomUUID();
    ctx.verificationCtx.profileOwners.set("personal", ownerProfileId, owner.user.id);
    await ctx.verificationCtx.verificationService.submitFullVerificationRequest("personal", ownerProfileId);
    await ctx.verificationCtx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: "personal",
      profileId: ownerProfileId,
      decision: "verified",
      reviewerUserId: randomUUID(),
      reason: null,
    });
  });

  function requestHandler() {
    return withErrorHandling("card_request", createCardRequestHandler(authCtx.authService, ctx.cardService));
  }
  function postJson(url: string, body: unknown, token?: string) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  const requestBody = { idempotencyKey: "", cardholderKind: "personal", cardholderId: "", cardType: "virtual" };

  it("lets the profile owner request a card", async () => {
    const response = await requestHandler()(
      postJson("http://localhost/api/cards/request", { ...requestBody, idempotencyKey: randomUUID(), cardholderId: ownerProfileId }, ownerToken),
    );
    expect(response.status).toBe(201);
  });

  it("rejects a stranger requesting a card for someone else's profile", async () => {
    const response = await requestHandler()(
      postJson("http://localhost/api/cards/request", { ...requestBody, idempotencyKey: randomUUID(), cardholderId: ownerProfileId }, strangerToken),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await requestHandler()(
      postJson("http://localhost/api/cards/request", { ...requestBody, idempotencyKey: randomUUID(), cardholderId: ownerProfileId }),
    );
    expect(response.status).toBe(401);
  });

  describe("activate / freeze / cancel — cross-tenant", () => {
    async function issueACard(): Promise<string> {
      const card = await ctx.cardService.requestCard({
        idempotencyKey: randomUUID(),
        cardholder: { kind: "personal", id: ownerProfileId },
        cardType: "virtual",
        actingUserId: (await authCtx.authService.validateSession(ownerToken))!.user.id,
      });
      return card.id;
    }

    it("rejects a stranger activating another user's card", async () => {
      const cardId = await issueACard();
      const response = await withErrorHandling("card_activate", createCardActivateHandler(authCtx.authService, ctx.cardService))(
        postJson("http://localhost/api/cards/activate", { cardId }, strangerToken),
      );
      expect(response.status).toBe(403);
    });

    it("rejects a stranger freezing another user's card", async () => {
      const cardId = await issueACard();
      const response = await withErrorHandling("card_freeze", createCardFreezeHandler(authCtx.authService, ctx.cardService))(
        postJson("http://localhost/api/cards/freeze", { cardId }, strangerToken),
      );
      expect(response.status).toBe(403);
    });

    it("rejects a stranger cancelling another user's card", async () => {
      const cardId = await issueACard();
      const response = await withErrorHandling("card_cancel", createCardCancelHandler(authCtx.authService, ctx.cardService))(
        postJson("http://localhost/api/cards/cancel", { cardId, reason: "malicious" }, strangerToken),
      );
      expect(response.status).toBe(403);
    });
  });
});
