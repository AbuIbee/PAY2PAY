import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { SandboxPaymentProvider } from "@/lib/payments/sandboxPaymentProvider";
import { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createBankConnectHandler } from "./route";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md): route-level coverage
 * for the bank-connection endpoint — the HTTP boundary (unauthenticated / cross-tenant / a response
 * that never echoes the raw values it received), on top of BankConnectionService's own thorough
 * unit tests.
 */
describe("POST /api/relationships/accounts/bank/connect", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let bankConnectionService: BankConnectionService;
  let ownerToken: string;
  let strangerToken: string;
  let ownerProfileId: string;

  const VALID_ROUTING = "021000021";
  const VALID_ACCOUNT = "123456789012";

  beforeEach(async () => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
    bankConnectionService = new BankConnectionService({
      provider: new SandboxPaymentProvider("test-webhook-secret"),
      financialAccounts: relCtx.relationshipFinancialAccountService,
      mfa: relCtx.staffCtx.mfaService,
    });

    const owner = await authCtx.authService.signup({
      email: `bank-owner-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: `bank-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    strangerToken = stranger.token;
    ownerProfileId = randomUUID();
    relCtx.profileOwners.set("personal", ownerProfileId, owner.user.id);

    // SPRINT_19_FraudRisk_SecurityHardening: connectBankAccount now requires a fresh MFA step-up.
    const ownerSessionId = (await authCtx.authService.validateSession(ownerToken))!.sessionId;
    await grantStepUp(relCtx.staffCtx, owner.user.id, ownerSessionId);
  });

  function handler() {
    return withErrorHandling("relationship_account_bank_connect", createBankConnectHandler(authCtx.authService, bankConnectionService));
  }
  function postJson(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/relationships/accounts/bank/connect", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  const validBody = {
    actingParty: { kind: "personal", id: "" },
    institutionDisplayName: "Example Bank",
    accountHolderName: "Jordan Payer",
    routingNumber: VALID_ROUTING,
    accountNumber: VALID_ACCOUNT,
    accountNumberConfirm: VALID_ACCOUNT,
    accountSubtype: "checking",
  };

  it("connects a bank account for the profile owner and never echoes the raw routing/account number", async () => {
    const response = await handler()(postJson({ ...validBody, actingParty: { kind: "personal", id: ownerProfileId } }, ownerToken));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { account: { maskedLast4: string } };
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(VALID_ACCOUNT);
    expect(raw).not.toContain(VALID_ROUTING);
    expect(body.account.maskedLast4).toBe(VALID_ACCOUNT.slice(-4));
  });

  it("rejects a stranger connecting a bank account for someone else's profile", async () => {
    const response = await handler()(postJson({ ...validBody, actingParty: { kind: "personal", id: ownerProfileId } }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(postJson({ ...validBody, actingParty: { kind: "personal", id: ownerProfileId } }));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed routing number with 400, independent of client-side validation", async () => {
    const response = await handler()(
      postJson({ ...validBody, actingParty: { kind: "personal", id: ownerProfileId }, routingNumber: "not-a-routing-number" }, ownerToken),
    );
    expect(response.status).toBe(400);
  });
});
