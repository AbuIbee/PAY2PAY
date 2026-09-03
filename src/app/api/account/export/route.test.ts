import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, createTestAuthService, TEST_ADULT_DATE_OF_BIRTH } from "@/lib/auth/testFakes";
import { createTestDataExportService } from "@/lib/compliance/testFakes";
import { createAccountExportHandler } from "./route";

describe("GET /api/account/export", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { dataExportService } = createTestDataExportService();
    const response = await withErrorHandling("account_export", createAccountExportHandler(authCtx.authService, dataExportService))(
      new NextRequest("http://localhost/api/account/export"),
    );
    expect(response.status).toBe(401);
  });

  it("returns the authenticated caller's own data, keyed by their session — never a request parameter", async () => {
    const authCtx = createTestAuthService();
    const { dataExportService, personalProfiles, agreementCtx, accounts } = createTestDataExportService();
    const user = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "export-me@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    accounts.emails.set(user.user.id, "export-me@example.com");
    const profile = await personalProfiles.insert(user.user.id);
    agreementCtx.profileOwners.set("personal", profile.id, user.user.id);

    const response = await withErrorHandling("account_export", createAccountExportHandler(authCtx.authService, dataExportService))(
      new NextRequest("http://localhost/api/account/export", { headers: { cookie: `p2p_session=${user.token}` } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBe(user.user.id);
    expect(body.email).toBe("export-me@example.com");
  });
});
