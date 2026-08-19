import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestAuthService, TEST_ADULT_DATE_OF_BIRTH } from "@/lib/auth/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import type { StaffDisplayInfo, StaffDisplayReader } from "@/lib/staff/staffDisplayReader";
import { createStaffListHandler } from "./route";

class FakeStaffDisplayReader implements StaffDisplayReader {
  info = new Map<string, StaffDisplayInfo>();

  async loadDisplayInfo(userIds: string[]): Promise<Map<string, StaffDisplayInfo>> {
    const result = new Map<string, StaffDisplayInfo>();
    for (const id of userIds) {
      const found = this.info.get(id);
      if (found) result.set(id, found);
    }
    return result;
  }
}

describe("GET /api/staff", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { staffService } = createTestStaffService();
    const response = await withErrorHandling(
      "staff_list",
      createStaffListHandler(authCtx.authService, staffService, new FakeStaffDisplayReader()),
    )(new NextRequest("http://localhost/api/staff?businessProfileId=biz-1"));
    expect(response.status).toBe(401);
  });

  it("requires businessProfileId with a 400", async () => {
    const authCtx = createTestAuthService();
    const { staffService } = createTestStaffService();
    const user = await authCtx.authService.signup({
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await withErrorHandling(
      "staff_list",
      createStaffListHandler(authCtx.authService, staffService, new FakeStaffDisplayReader()),
    )(new NextRequest("http://localhost/api/staff", { headers: { cookie: `p2p_session=${user.token}` } }));
    expect(response.status).toBe(400);
  });

  it("resolves each staff member's name/email instead of leaking only a raw user ID", async () => {
    const authCtx = createTestAuthService();
    const { staffService, staffMembers } = createTestStaffService();
    const owner = await authCtx.authService.signup({
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const teammate = await authCtx.authService.signup({
      email: "teammate@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const businessProfileId = "biz-1";
    await staffMembers.insert({ businessProfileId, userId: owner.user.id, role: "owner", customRoleId: null, isAuthorizedRepresentative: true });
    await staffMembers.insert({ businessProfileId, userId: teammate.user.id, role: "manager", customRoleId: null, isAuthorizedRepresentative: false });

    const displayReader = new FakeStaffDisplayReader();
    displayReader.info.set(owner.user.id, { name: "Jane Owner", email: "owner@example.com" });
    // Deliberately leave `teammate` unset to prove the missing-name case never falls back to a raw ID.

    const response = await withErrorHandling("staff_list", createStaffListHandler(authCtx.authService, staffService, displayReader))(
      new NextRequest(`http://localhost/api/staff?businessProfileId=${businessProfileId}`, {
        headers: { cookie: `p2p_session=${owner.token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const rows: Array<{ userId: string; name: string | null; email: string | null }> = body.staff;

    const ownerRow = rows.find((r) => r.userId === owner.user.id);
    expect(ownerRow?.name).toBe("Jane Owner");
    expect(ownerRow?.email).toBe("owner@example.com");

    const teammateRow = rows.find((r) => r.userId === teammate.user.id);
    expect(teammateRow?.name).toBeNull();
    expect(teammateRow?.email).toBeNull();

    // Every row must expose a resolvable identity or an explicit null — never a bare/truncated UUID string standing in for one.
    for (const row of rows) {
      expect(row.name === null || row.name.length > 0).toBe(true);
    }
  });
});
