import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { AchMandateService } from "@/lib/ach/achMandateService";
import { InMemoryAchMandateRepository } from "@/lib/ach/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAuthorizeAgreementMandateHandler } from "./route";

class InMemoryAuditEventRepositoryForMandates implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;
  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }
  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

/**
 * Restore agreement payment functionality: covers the HTTP boundary for the new one-click debtor
 * mandate-authorization endpoint — the exact CTA target Step 3/Step 5 send a debtor to when they've
 * already assigned a relationship funding account but haven't yet authorized this specific agreement
 * to debit it.
 */
describe("POST /api/agreements/payment-setup/authorize-mandate", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let achMandateService: AchMandateService;

  beforeEach(() => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
    achMandateService = new AchMandateService({
      mandates: new InMemoryAchMandateRepository(),
      profileOwners: relCtx.profileOwners,
      audit: new AuditService(new InMemoryAuditEventRepositoryForMandates()),
    });
  });

  async function createLinkedAgreementWithFunding() {
    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `mandate-authorize-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `mandate-authorize-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    relCtx.profileOwners.set("personal", creditorProfileId, creditor.user.id);
    relCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);
    relCtx.users.set(debtor.user.email, debtor.user.id);

    const { relationship, invitation } = await relCtx.relationshipInvitationService.createInvitation({
      actingUserId: creditor.user.id,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail: debtor.user.email,
      inviteeRole: "debtor",
    });
    await relCtx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtor.user.id,
      actingParty: { kind: "personal", id: debtorProfileId },
    });

    const created = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.id,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    relCtx.agreements.byId.get(created.agreement.id)!.relationshipId = relationship.id;

    const account = await relCtx.relationshipFinancialAccountService.addAccount({
      actingUserId: debtor.user.id,
      actingParty: { kind: "personal", id: debtorProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "sandbox_bank_debtor_1",
      maskedLast4: "1234",
      institutionDisplayName: "Test Bank",
    });
    await relCtx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
    await relCtx.relationshipFinancialAccountService.assignAccount({
      actingUserId: debtor.user.id,
      relationshipId: relationship.id,
      financialAccountId: account.id,
      usage: "funding",
    });

    return { agreementId: created.agreement.id, creditor, debtor };
  }

  function handler() {
    return withErrorHandling(
      "agreement_payment_setup_authorize_mandate",
      createAuthorizeAgreementMandateHandler(authCtx.authService, relCtx.agreementService, relCtx.relationshipFinancialAccountService, achMandateService),
    );
  }

  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/agreements/payment-setup/authorize-mandate", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("authorizes a mandate for the debtor using their already-assigned funding account", async () => {
    const { agreementId, debtor } = await createLinkedAgreementWithFunding();
    const response = await handler()(post({ agreementId }, debtor.token));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("active");

    const active = await achMandateService.getActiveMandate(agreementId);
    expect(active?.bankAccountRef).toBe("sandbox_bank_debtor_1");
  });

  it("rejects the creditor — only the debtor may authorize a mandate", async () => {
    const { agreementId, creditor } = await createLinkedAgreementWithFunding();
    const response = await handler()(post({ agreementId }, creditor.token));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { agreementId } = await createLinkedAgreementWithFunding();
    const response = await handler()(post({ agreementId }));
    expect(response.status).toBe(401);
  });

  it("400s with a clear message when the debtor has no funding account assigned yet", async () => {
    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `mandate-authorize-nofund-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `mandate-authorize-nofund-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    relCtx.profileOwners.set("personal", creditorProfileId, creditor.user.id);
    relCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);
    relCtx.users.set(debtor.user.email, debtor.user.id);
    const { relationship, invitation } = await relCtx.relationshipInvitationService.createInvitation({
      actingUserId: creditor.user.id,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail: debtor.user.email,
      inviteeRole: "debtor",
    });
    await relCtx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtor.user.id,
      actingParty: { kind: "personal", id: debtorProfileId },
    });
    const created = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.id,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    relCtx.agreements.byId.get(created.agreement.id)!.relationshipId = relationship.id;

    const response = await handler()(post({ agreementId: created.agreement.id }, debtor.token));
    expect(response.status).toBe(400);
  });
});
