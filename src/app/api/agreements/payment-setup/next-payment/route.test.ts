import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { createTestLedgerService, createTestBalanceService } from "@/lib/ledger/testFakes";
import type { AgreementInstallmentStatusReader, InstallmentWithStatus } from "@/lib/agreements/agreementProgressService";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementNextPaymentHandler } from "./route";

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

/** Mirrors DrizzleAgreementInstallmentStatusReader's contract against the in-memory schedule repository the relationship-services test harness already writes to at draft creation. */
class FakeInstallmentReader implements AgreementInstallmentStatusReader {
  constructor(private readonly ctx: ReturnType<typeof createTestRelationshipServices>) {}
  async listForAgreement(agreementId: string): Promise<InstallmentWithStatus[]> {
    const agreement = this.ctx.agreements.byId.get(agreementId);
    if (!agreement?.currentVersionId) return [];
    const items = await this.ctx.scheduleItems.listForVersion(agreement.currentVersionId);
    return items.map((item) => ({ id: `${agreementId}:${item.sequenceNumber}`, sequenceNumber: item.sequenceNumber, dueDate: item.dueDate, amountMinorUnits: item.amountMinorUnits, status: "scheduled" }));
  }
}

/**
 * Restore agreement payment functionality: covers the structured data feed for the "Make Payment"
 * section — proves it never leaks a raw provider account reference (only a masked label), degrades
 * remaining balance to null rather than 500ing when it isn't computable yet, and returns null for
 * fundingAccountLabel to the creditor (never surfaces the debtor's account to the wrong party).
 */
describe("GET /api/agreements/payment-setup/next-payment", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  let installments: FakeInstallmentReader;

  beforeEach(() => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
    ledgerCtx = createTestLedgerService();
    balanceCtx = createTestBalanceService(ledgerCtx);
    installments = new FakeInstallmentReader(relCtx);
  });

  async function createLinkedAgreementWithFunding() {
    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `next-payment-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `next-payment-debtor-${randomUUID()}@example.com`,
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
      maskedLast4: "4242",
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
      "agreement_payment_setup_next_payment",
      createAgreementNextPaymentHandler(
        authCtx.authService,
        relCtx.agreementService,
        installments,
        balanceCtx.balanceService,
        relCtx.relationshipFinancialAccountService,
        { getDisplayName: async () => "Test Creditor" },
      ),
    );
  }

  function get(agreementId: string, token?: string) {
    return new NextRequest(`http://localhost/api/agreements/payment-setup/next-payment?id=${agreementId}`, {
      method: "GET",
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("returns the next unpaid installment, remaining balance, and a masked funding label for the debtor", async () => {
    const { agreementId, debtor } = await createLinkedAgreementWithFunding();
    balanceCtx.terms.set(agreementId, 120_000, "USD");

    const response = await handler()(get(agreementId, debtor.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nextInstallment: { sequenceNumber: number; amountMinorUnits: number } | null;
      remainingBalanceMinorUnits: number | null;
      fundingAccountLabel: string | null;
    };
    expect(body.nextInstallment?.sequenceNumber).toBe(0);
    expect(body.nextInstallment?.amountMinorUnits).toBe(20_000);
    expect(body.remainingBalanceMinorUnits).toBe(120_000);
    expect(body.fundingAccountLabel).toBe("Test Bank ····4242");
  });

  it("never surfaces the debtor's funding account label to the creditor", async () => {
    const { agreementId, creditor } = await createLinkedAgreementWithFunding();
    balanceCtx.terms.set(agreementId, 120_000, "USD");

    const response = await handler()(get(agreementId, creditor.token));
    const body = (await response.json()) as { fundingAccountLabel: string | null };
    expect(body.fundingAccountLabel).toBeNull();
  });

  it("Fix the 'Make payment' button: returns the creditor's display name to the debtor for the payment review step", async () => {
    const { agreementId, debtor } = await createLinkedAgreementWithFunding();
    balanceCtx.terms.set(agreementId, 120_000, "USD");

    const response = await handler()(get(agreementId, debtor.token));
    const body = (await response.json()) as { recipientDisplayName: string | null };
    expect(body.recipientDisplayName).toBe("Test Creditor");
  });

  it("Fix the 'Make payment' button: never returns a recipientDisplayName to the creditor (only the debtor pays, so only the debtor needs to know who they're paying)", async () => {
    const { agreementId, creditor } = await createLinkedAgreementWithFunding();
    balanceCtx.terms.set(agreementId, 120_000, "USD");

    const response = await handler()(get(agreementId, creditor.token));
    const body = (await response.json()) as { recipientDisplayName: string | null };
    expect(body.recipientDisplayName).toBeNull();
  });

  it("degrades remaining balance to null (never 500s) when the balance isn't computable yet", async () => {
    const { agreementId, debtor } = await createLinkedAgreementWithFunding();
    // No terms seeded in balanceCtx — getAgreementBalance throws.

    const response = await handler()(get(agreementId, debtor.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { remainingBalanceMinorUnits: number | null };
    expect(body.remainingBalanceMinorUnits).toBeNull();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { agreementId } = await createLinkedAgreementWithFunding();
    const response = await handler()(get(agreementId));
    expect(response.status).toBe(401);
  });
});
