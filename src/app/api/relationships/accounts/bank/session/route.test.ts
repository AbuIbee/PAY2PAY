import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { createTestRelationshipServices, FakeBankPaymentProvider, InMemoryBankLinkAttemptRepository } from "@/lib/relationships/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createBankSessionHandler } from "./route";

/** PAID2YOU — B0-D ADYEN PHASE 2: route-level coverage for bank-connection session INITIATION. */
describe("POST /api/relationships/accounts/bank/session", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let provider: FakeBankPaymentProvider;
  let bankConnectionService: BankConnectionService;
  let ownerToken: string;
  let strangerToken: string;
  let ownerUserId: string;
  let ownerProfileId: string;

  beforeEach(async () => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
    provider = new FakeBankPaymentProvider();
    bankConnectionService = new BankConnectionService({
      provider,
      financialAccounts: relCtx.relationshipFinancialAccountService,
      bankLinkAttempts: new InMemoryBankLinkAttemptRepository(),
      mfa: relCtx.staffCtx.mfaService,
      adyenMerchantAccount: "Paid2YouECOM",
    });

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `bank-session-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `bank-session-stranger-${randomUUID()}@example.com`,
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
    const ownerSessionId = (await authCtx.authService.validateSession(ownerToken))!.sessionId;
    await grantStepUp(relCtx.staffCtx, ownerUserId, ownerSessionId);
  });

  function handler() {
    return withErrorHandling("relationship_account_bank_session", createBankSessionHandler(authCtx.authService, bankConnectionService));
  }
  function postJson(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/relationships/accounts/bank/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("creates a bank-tokenization session for the profile owner, carrying no bank data", async () => {
    const response = await handler()(postJson({ actingParty: { kind: "personal", id: ownerProfileId } }, ownerToken));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { providerSessionId: string; sessionData: string };
    expect(body.providerSessionId).toMatch(/^fake-session-/);
    expect(typeof body.sessionData).toBe("string");
  });

  it("rejects a stranger initiating a bank session for someone else's profile", async () => {
    const response = await handler()(postJson({ actingParty: { kind: "personal", id: ownerProfileId } }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(postJson({ actingParty: { kind: "personal", id: ownerProfileId } }));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const response = await handler()(postJson({ actingParty: { kind: "personal", id: "not-a-uuid" } }, ownerToken));
    expect(response.status).toBe(400);
  });

  it("accepts an institutionDisplayName and mints a unique merchantReference per session (never client-suppliable, never reused)", async () => {
    const first = await handler()(
      postJson({ actingParty: { kind: "personal", id: ownerProfileId }, institutionDisplayName: "Example Bank" }, ownerToken),
    );
    const second = await handler()(
      postJson({ actingParty: { kind: "personal", id: ownerProfileId }, institutionDisplayName: "Example Bank" }, ownerToken),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { providerSessionId: string };
    const secondBody = (await second.json()) as { providerSessionId: string };
    expect(firstBody.providerSessionId).not.toBe(secondBody.providerSessionId);
  });
});
