import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestLegalAcceptanceService } from "@/lib/legal/legalAcceptanceTestFakes";
import { BusinessActivationService } from "@/lib/organizations/businessActivationService";
import { InMemoryBusinessVerificationRepository } from "@/lib/organizations/businessVerificationTestFakes";
import { createTestWorkspaceContextService } from "@/lib/organizations/testFakes";
import { WORKSPACE_COOKIE_NAME } from "@/lib/organizations/workspaceCookie";
import { InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { createWorkspaceActiveGetHandler, createWorkspaceActiveSetHandler } from "./route";

function readSetCookie(response: Response, name: string): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = headers.getSetCookie ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const raw of rawCookies) {
    const [pair] = raw.split(";");
    const separatorIndex = pair?.indexOf("=") ?? -1;
    if (!pair || separatorIndex === -1) continue;
    if (pair.slice(0, separatorIndex) === name) return pair.slice(separatorIndex + 1);
  }
  return undefined;
}

describe("GET/POST /api/workspace/active", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let workspaceCtx: ReturnType<typeof createTestWorkspaceContextService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    workspaceCtx = createTestWorkspaceContextService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "workspace-switcher@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
  });

  function activationService() {
    return new BusinessActivationService(
      workspaceCtx.businessProfiles,
      new InMemoryBusinessVerificationRepository(),
      new InMemorySubscriptionRepository(),
      createTestLegalAcceptanceService().legalAcceptanceService,
    );
  }

  function getHandler() {
    return withErrorHandling(
      "workspace_active_get",
      createWorkspaceActiveGetHandler(authCtx.authService, workspaceCtx.workspaceContext, workspaceCtx.businessProfiles, activationService()),
    );
  }

  function setHandler() {
    return withErrorHandling(
      "workspace_active_set",
      createWorkspaceActiveSetHandler(authCtx.authService, workspaceCtx.workspaceContext, workspaceCtx.businessProfiles, activationService()),
    );
  }

  function getRequest(cookieValue?: string) {
    const cookie = [`p2p_session=${token}`, cookieValue ? `${WORKSPACE_COOKIE_NAME}=${cookieValue}` : null].filter(Boolean).join("; ");
    return new NextRequest("http://localhost/api/workspace/active", { method: "GET", headers: { cookie } });
  }

  function postRequest(body: unknown) {
    return new NextRequest("http://localhost/api/workspace/active", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    });
  }

  it("defaults to the personal workspace with no cookie", async () => {
    const response = await getHandler()(getRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("switching to an organization the caller is an active member of is server-validated and succeeds", async () => {
    const org = await workspaceCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "CA",
    });
    workspaceCtx.staffMembers.seed({ businessProfileId: org.id, userId, role: "OWNER" });

    const setResponse = await setHandler()(postRequest({ kind: "organization", organizationId: org.id }));
    expect(setResponse.status).toBe(200);
    const cookieValue = readSetCookie(setResponse, WORKSPACE_COOKIE_NAME);
    expect(cookieValue).toBeTruthy();

    const getResponse = await getHandler()(getRequest(cookieValue));
    const body = (await getResponse.json()) as { kind: string; organizationId: string };
    expect(body.kind).toBe("organization");
    expect(body.organizationId).toBe(org.id);
  });

  it("a non-member attempting to switch into an organization falls back to personal — never trusts the client-supplied id", async () => {
    const org = await workspaceCtx.businessProfiles.insert({
      ownerUserId: "someone-else",
      legalBusinessName: "Not Yours LLC",
      displayName: "Not Yours",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "CA",
    });
    const response = await setHandler()(postRequest({ kind: "organization", organizationId: org.id }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("an invalid/nonexistent organization id falls back to personal with the same shape as a non-member", async () => {
    const response = await setHandler()(postRequest({ kind: "organization", organizationId: randomUUID() }));
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("a removed membership causes the workspace to fall back to personal on the next read", async () => {
    const org = await workspaceCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "CA",
    });
    const member = workspaceCtx.staffMembers.seed({ businessProfileId: org.id, userId, role: "VIEWER" });
    const setResponse = await setHandler()(postRequest({ kind: "organization", organizationId: org.id }));
    const cookieValue = readSetCookie(setResponse, WORKSPACE_COOKIE_NAME) as string;

    await workspaceCtx.staffMembers.markRemoved(member.id, new Date());

    const getResponse = await getHandler()(getRequest(cookieValue));
    const body = (await getResponse.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await setHandler()(
      new NextRequest("http://localhost/api/workspace/active", {
        method: "POST",
        body: JSON.stringify({ kind: "personal" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
