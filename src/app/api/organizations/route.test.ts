import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createBusinessOnboardingTestHarness } from "@/lib/organizations/businessOnboardingTestFakes";
import { createTestWorkspaceContextService } from "@/lib/organizations/testFakes";
import { createOrganizationsCreateHandler, createOrganizationsListHandler } from "./route";

const representative = { firstName: "Jane", lastName: "Doe", title: "CEO", email: "jane@abc.com", phone: "+15555550100", relationshipToBusiness: "Owner" };

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    legalBusinessName: "ABC Trucking LLC",
    displayName: "ABC Trucking",
    entityType: "LLC",
    industry: "TRUCKING",
    formationJurisdiction: "DE",
    businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
    businessEmail: "billing@abctrucking.com",
    country: "US",
    state: "DE",
    representative,
    ...overrides,
  };
}

describe("GET/POST /api/organizations", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let onboardingCtx: Awaited<ReturnType<typeof createBusinessOnboardingTestHarness>>;
  let workspaceCtx: ReturnType<typeof createTestWorkspaceContextService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    onboardingCtx = await createBusinessOnboardingTestHarness();
    workspaceCtx = createTestWorkspaceContextService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "founder@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function postHandler() {
    return withErrorHandling("organizations_create", createOrganizationsCreateHandler(authCtx.authService, onboardingCtx.onboarding));
  }

  function listHandler() {
    return withErrorHandling("organizations_list", createOrganizationsListHandler(authCtx.authService, workspaceCtx.workspaceContext));
  }

  function postRequest(body: unknown) {
    return new NextRequest("http://localhost/api/organizations", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    });
  }

  it("creates a new Business organization from valid Business Details", async () => {
    const response = await postHandler()(postRequest(validBody()));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { organizationId: string; onboardingStep: string };
    expect(body.onboardingStep).toBe("details_complete");
    expect(body.organizationId).toBeTruthy();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await postHandler()(
      new NextRequest("http://localhost/api/organizations", {
        method: "POST",
        body: JSON.stringify(validBody()),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects an invalid industry value with 400", async () => {
    const response = await postHandler()(postRequest(validBody({ industry: "NOT_A_REAL_INDUSTRY" })));
    expect(response.status).toBe(400);
  });

  it("GET lists no organizations for a user with none (Personal-only)", async () => {
    const response = await listHandler()(
      new NextRequest("http://localhost/api/organizations", { method: "GET", headers: { cookie: `p2p_session=${token}` } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { organizations: unknown[] };
    expect(body.organizations).toEqual([]);
  });

  it("GET rejects an unauthenticated request with 401", async () => {
    const response = await listHandler()(new NextRequest("http://localhost/api/organizations", { method: "GET" }));
    expect(response.status).toBe(401);
  });
});
