import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { createBusinessDashboardHandler } from "./route";

function getWithCookie(businessProfileId: string | null, token?: string) {
  const url = businessProfileId
    ? `http://localhost/api/dashboard/business?businessProfileId=${businessProfileId}`
    : "http://localhost/api/dashboard/business";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

const BASE_TERMS: AgreementTerms = {
  category: "invoice",
  description: "Repair invoice",
  originalAmountMinorUnits: 50000,
  previousPaymentsMinorUnits: 0,
  currentPrincipalMinorUnits: 50000,
  firstPaymentMinorUnits: 25000,
  installmentAmountMinorUnits: 25000,
  firstPaymentDate: "2026-09-01",
  finalPaymentMinorUnits: 25000,
  numberOfInstallments: 2,
  earlyPayoffTerms: "Allowed anytime.",
  hardshipRules: "Case by case.",
  partialPaymentRules: "Allowed.",
  settlementRules: "Negotiable.",
  disputeProcedure: "Contact support.",
  supportingEvidenceReferences: [],
};

describe("GET /api/dashboard/business", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    agreementCtx = createTestAgreementService();
    ledgerCtx = createTestLedgerService();
    balanceCtx = createTestBalanceService(ledgerCtx);
    const result = await authCtx.authService.signup({
      email: "dash-business@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
  });

  function handlerFor() {
    return withErrorHandling(
      "dashboard_business",
      createBusinessDashboardHandler(
        authCtx.authService,
        accessCtx.profileAccessService,
        agreementCtx.agreementService,
        balanceCtx.balanceService,
        agreementCtx.staffCtx.staffService,
      ),
    );
  }

  /**
   * Dashboard consistency fix: this helper previously ALSO manually seeded an "owner"
   * business_staff_member row (via agreementCtx.staffCtx.staffMembers.insert), on the stated
   * assumption "an owner is always active staff (Sprint 4)" — that assumption does not actually hold
   * in production: BusinessProfileService.createBusinessProfile has never seeded any such row, so
   * every real business owner has none. Seeding it here masked exactly the bug the Product Owner hit
   * live (GET /api/dashboard/business 403ing for a real owner). This helper now mirrors real
   * createBusinessProfile behavior — no staff row — matching every actual production business.
   */
  async function seedOwnedBusiness() {
    const business = await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    agreementCtx.profileOwners.set("business", business.id, userId);
    return business;
  }

  it("dashboard consistency fix (root cause): returns 200 for a real business owner who has no business_staff_member row — this is the exact live regression (previously 403'd via staffService.listStaff's active-staff requirement, silently blanking the entire summary section)", async () => {
    const business = await seedOwnedBusiness();
    const response = await handlerFor()(getWithCookie(business.id, token));
    expect(response.status).toBe(200);
  });

  it("returns real empty-state data for an owned business, including the upcomingPayments/requests fields the Personal dashboard also has", async () => {
    const business = await seedOwnedBusiness();
    const response = await handlerFor()(getWithCookie(business.id, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      receivablesMinorUnits: 0,
      payablesMinorUnits: 0,
      agreements: [],
      customers: [],
      upcomingPayments: [],
      requests: [],
      staffCount: 0,
    });
  });

  it("staffCount still correctly reflects an explicitly-added staff member, even though the owner themself has no row", async () => {
    const business = await seedOwnedBusiness();
    await agreementCtx.staffCtx.staffMembers.insert({
      businessProfileId: business.id,
      userId: "some-other-staff-user",
      role: "manager",
      customRoleId: null,
      isAuthorizedRepresentative: false,
    });
    const response = await handlerFor()(getWithCookie(business.id, token));
    const body = (await response.json()) as { staffCount: number };
    expect(body.staffCount).toBe(1);
  });

  it("rejects a business the caller does not own with 403", async () => {
    const otherBusiness = await accessCtx.businessProfiles.insert({
      ownerUserId: "someone-else",
      legalBusinessName: "Not Yours LLC",
      displayName: "Not Yours",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const response = await handlerFor()(getWithCookie(otherBusiness.id, token));
    expect(response.status).toBe(403);
  });

  it("rejects a missing businessProfileId with 400", async () => {
    const response = await handlerFor()(getWithCookie(null, token));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie("00000000-0000-0000-0000-000000000000"));
    expect(response.status).toBe(401);
  });

  it("sums receivables from active agreements where the business is creditor, and lists the counterparty as a customer", async () => {
    const business = await seedOwnedBusiness();
    const agreement = await agreementCtx.agreements.insert({
      creditorProfileKind: "business",
      creditorProfileId: business.id,
      debtorProfileKind: "personal",
      debtorProfileId: "customer-1",
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

    const response = await handlerFor()(getWithCookie(business.id, token));
    const body = (await response.json()) as {
      receivablesMinorUnits: number;
      payablesMinorUnits: number;
      customers: Array<{ kind: string; id: string }>;
    };
    expect(body.receivablesMinorUnits).toBe(50000);
    expect(body.payablesMinorUnits).toBe(0);
    expect(body.customers).toEqual([{ kind: "personal", id: "customer-1" }]);
  });
});
