import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { createPersonalDashboardHandler } from "./route";

function getWithCookie(token?: string) {
  return new NextRequest("http://localhost/api/dashboard/personal", {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

const BASE_TERMS: AgreementTerms = {
  category: "personal_loan",
  description: "Loan for car repair",
  originalAmountMinorUnits: 100000,
  previousPaymentsMinorUnits: 0,
  currentPrincipalMinorUnits: 100000,
  firstPaymentMinorUnits: 10000,
  installmentAmountMinorUnits: 10000,
  firstPaymentDate: "2026-09-01",
  finalPaymentMinorUnits: 10000,
  numberOfInstallments: 10,
  earlyPayoffTerms: "Allowed anytime.",
  hardshipRules: "Case by case.",
  partialPaymentRules: "Allowed.",
  settlementRules: "Negotiable.",
  disputeProcedure: "Contact support.",
  supportingEvidenceReferences: [],
};

describe("GET /api/dashboard/personal", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let profileAccessService: ProfileAccessService;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  let relationshipCtx: ReturnType<typeof createTestRelationshipServices>;
  let token: string;
  let userId: string;
  let personalProfileId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    // Shares authCtx's own personalProfiles store, mirroring how getAuthService()/getProfileAccessService()
    // both ultimately read the same production `personal_profile` table.
    profileAccessService = new ProfileAccessService(authCtx.personalProfiles, new InMemoryBusinessProfileRepository());
    agreementCtx = createTestAgreementService();
    ledgerCtx = createTestLedgerService();
    balanceCtx = createTestBalanceService(ledgerCtx);
    relationshipCtx = createTestRelationshipServices();

    const result = await authCtx.authService.signup({
      email: "dash-personal@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
    const profile = await authCtx.personalProfiles.findByUserId(userId);
    personalProfileId = profile!.id;
    agreementCtx.profileOwners.set("personal", personalProfileId, userId);
  });

  function handlerFor() {
    return withErrorHandling(
      "dashboard_personal",
      createPersonalDashboardHandler(
        authCtx.authService,
        profileAccessService,
        agreementCtx.agreementService,
        balanceCtx.balanceService,
        relationshipCtx.relationshipInvitationService,
      ),
    );
  }

  it("returns real empty-state data, not fabricated numbers", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      moneyIOweMinorUnits: 0,
      moneyOwedToMeMinorUnits: 0,
      agreements: [],
      upcomingPayments: [],
      requests: [],
    });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("sums the ledger-reconstructed remaining balance of active agreements where I am the debtor, and lists future installments", async () => {
    const agreement = await agreementCtx.agreements.insert({
      creditorProfileKind: "personal",
      creditorProfileId: "counterparty-1",
      debtorProfileKind: "personal",
      debtorProfileId: personalProfileId,
      currency: "USD",
      createdByUserId: userId,
    });
    const version = await agreementCtx.versions.insert({
      agreementId: agreement.id,
      versionNumber: 1,
      parentVersionId: null,
      isOriginal: true,
      producedBy: userId,
      frequency: "monthly",
      feeAllocation: "split_evenly",
      terms: BASE_TERMS,
    });
    agreementCtx.agreements.byId.get(agreement.id)!.status = "active";
    await agreementCtx.agreements.setCurrentVersionId(agreement.id, version.id);
    balanceCtx.terms.set(agreement.id, BASE_TERMS.currentPrincipalMinorUnits);
    await agreementCtx.scheduleItems.replaceForVersion(version.id, [
      { sequenceNumber: 0, dueDate: "2099-01-01", amountMinorUnits: 10000 },
      { sequenceNumber: 1, dueDate: "2000-01-01", amountMinorUnits: 10000 }, // already past — never shows as "upcoming"
    ]);

    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      moneyIOweMinorUnits: number;
      moneyOwedToMeMinorUnits: number;
      agreements: Array<{ id: string; status: string }>;
      upcomingPayments: Array<{ agreementId: string; dueDate: string }>;
    };
    expect(body.moneyIOweMinorUnits).toBe(100000);
    expect(body.moneyOwedToMeMinorUnits).toBe(0);
    expect(body.agreements).toEqual([{ id: agreement.id, status: "active" }]);
    expect(body.upcomingPayments).toEqual([{ agreementId: agreement.id, dueDate: "2099-01-01", amountMinorUnits: 10000 }]);
  });

  it("lists an agreement awaiting my signature under `requests`, but not one I've already signed", async () => {
    const agreement = await agreementCtx.agreements.insert({
      creditorProfileKind: "personal",
      creditorProfileId: "counterparty-1",
      debtorProfileKind: "personal",
      debtorProfileId: personalProfileId,
      currency: "USD",
      createdByUserId: userId,
    });
    const version = await agreementCtx.versions.insert({
      agreementId: agreement.id,
      versionNumber: 1,
      parentVersionId: null,
      isOriginal: true,
      producedBy: userId,
      frequency: "monthly",
      feeAllocation: "split_evenly",
      terms: BASE_TERMS,
    });
    agreementCtx.agreements.byId.get(agreement.id)!.status = "awaiting_signatures";
    await agreementCtx.agreements.setCurrentVersionId(agreement.id, version.id);

    const response = await handlerFor()(getWithCookie(token));
    const body = (await response.json()) as { requests: Array<{ agreementId: string; reason: string }> };
    expect(body.requests).toEqual([{ agreementId: agreement.id, reason: "awaiting_your_signature" }]);

    // Once I've (the debtor) signed, it must drop off the list.
    agreementCtx.versions.byId.get(version.id)!.debtorSignedAt = new Date();
    const response2 = await handlerFor()(getWithCookie(token));
    const body2 = (await response2.json()) as { requests: unknown[] };
    expect(body2.requests).toEqual([]);
  });
});
