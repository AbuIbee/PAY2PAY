import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { createTestRelationshipServices, FakeBankPaymentProvider, InMemoryBankLinkAttemptRepository } from "@/lib/relationships/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createBankConnectionStatusHandler } from "./route";

const ADYEN_MERCHANT_ACCOUNT = "Paid2YouECOM";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): this route is now a purely
 * READ-ONLY status poll — no client-triggered "finalize" mutation exists any more (see
 * `BankConnectionService`'s own doc comment). Completion happens exclusively via the two Adyen
 * webhooks under test in `bankConnectionService.test.ts`; this file covers only the HTTP boundary
 * (unauthenticated / cross-tenant / malformed query / correct status echo).
 */
describe("GET /api/relationships/accounts/bank/connect", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let provider: FakeBankPaymentProvider;
  let bankLinkAttempts: InMemoryBankLinkAttemptRepository;
  let bankConnectionService: BankConnectionService;
  let ownerToken: string;
  let strangerToken: string;
  let ownerUserId: string;
  let ownerSessionId: string;
  let ownerProfileId: string;

  beforeEach(async () => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
    provider = new FakeBankPaymentProvider();
    bankLinkAttempts = new InMemoryBankLinkAttemptRepository();
    bankConnectionService = new BankConnectionService({
      provider,
      financialAccounts: relCtx.relationshipFinancialAccountService,
      bankLinkAttempts,
      mfa: relCtx.staffCtx.mfaService,
      adyenMerchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `bank-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `bank-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    strangerToken = stranger.token;
    ownerUserId = owner.user.id;
    ownerProfileId = randomUUID();
    relCtx.profileOwners.set("personal", ownerProfileId, ownerUserId);

    ownerSessionId = (await authCtx.authService.validateSession(ownerToken))!.sessionId;
    await grantStepUp(relCtx.staffCtx, ownerUserId, ownerSessionId);
  });

  function handler() {
    return withErrorHandling("relationship_account_bank_connect_status", createBankConnectionStatusHandler(authCtx.authService, bankConnectionService));
  }
  function getRequest(params: Record<string, string>, token?: string) {
    const url = new URL("http://localhost/api/relationships/accounts/bank/connect");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return new NextRequest(url, {
      method: "GET",
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  async function startSession() {
    return bankConnectionService.initiateBankConnection({
      actingUserId: ownerUserId,
      actingSessionId: ownerSessionId,
      actingParty: { kind: "personal", id: ownerProfileId },
      returnUrl: "https://app.test/payment-methods/add-bank",
      institutionDisplayName: "Example Bank",
    });
  }

  async function confirmAndComplete(providerSessionId: string, storedPaymentMethodId: string) {
    const attempt = bankLinkAttempts.byProviderSessionId.get(providerSessionId);
    if (!attempt) throw new Error("attempt not found in test fixture");
    await bankConnectionService.recordAuthorisationConfirmed({
      merchantReference: attempt.merchantReference,
      pspReference: `psp_${attempt.merchantReference}`,
      success: true,
    });
    await bankConnectionService.completeFromTokenEvent({
      pspReference: `psp_${attempt.merchantReference}`,
      shopperReference: attempt.shopperReference,
      storedPaymentMethodId,
      merchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
  }

  it("reports pending immediately after initiate — before either webhook fires", async () => {
    const session = await startSession();
    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: ownerProfileId, providerSessionId: session.providerSessionId }, ownerToken),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; financialAccountId: string | null };
    expect(body).toEqual({ status: "pending", financialAccountId: null });
  });

  it("reports completed with the resulting financialAccountId once both webhooks have confirmed the token, and echoes nothing beyond status + id", async () => {
    const session = await startSession();
    await confirmAndComplete(session.providerSessionId, "sm_route_token");

    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: ownerProfileId, providerSessionId: session.providerSessionId }, ownerToken),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; financialAccountId: string | null };
    expect(body.status).toBe("completed");
    expect(body.financialAccountId).toBeTruthy();
    expect(Object.keys(body).sort()).toEqual(["financialAccountId", "status"]);
  });

  it("rejects a stranger polling the status of someone else's bank-connection attempt", async () => {
    const session = await startSession();
    const strangerProfileId = randomUUID();
    const strangerUserId = (await authCtx.authService.validateSession(strangerToken))!.user.id;
    relCtx.profileOwners.set("personal", strangerProfileId, strangerUserId);

    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: strangerProfileId, providerSessionId: session.providerSessionId }, strangerToken),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const session = await startSession();
    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: ownerProfileId, providerSessionId: session.providerSessionId }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a malformed/empty providerSessionId with 400", async () => {
    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: ownerProfileId, providerSessionId: "" }, ownerToken),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an unknown providerSessionId with a client error, never disclosing whether it belongs to someone else", async () => {
    const response = await handler()(
      getRequest({ actingPartyKind: "personal", actingPartyId: ownerProfileId, providerSessionId: "never-existed" }, ownerToken),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
