import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { createStaffInviteHandler } from "./route";

const BUSINESS_A = randomUUID();

function postWithCookie(body: unknown, token: string) {
  return new NextRequest("http://localhost/api/staff/invite", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/staff/invite", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let staffCtx: ReturnType<typeof createTestStaffService>;
  let ownerToken: string;
  let ownerUserId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    staffCtx = createTestStaffService();
    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "invite-owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;
    ownerUserId = owner.user.id;
    staffCtx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: ownerUserId, role: "owner" });
  });

  function handlerFor() {
    return withErrorHandling("staff_invite", createStaffInviteHandler(authCtx.authService, staffCtx.staffService));
  }

  it("invites successfully within the per-target-email limit", async () => {
    const response = await handlerFor()(
      postWithCookie({ businessProfileId: BUSINESS_A, email: "candidate@example.com", role: "manager" }, ownerToken),
    );
    expect(response.status).toBe(201);
  });

  it(
    "PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): blocks " +
      "spamming the same target email from many different businesses, even though no single " +
      "business's own pending-invitation-per-email rule (ConflictError) or per-inviter rate limit " +
      "would ever catch this — the target-email limiter is deliberately keyed by email alone, " +
      "cutting across businesses/inviters, which is the actual spam scenario against the invitee",
    async () => {
      const targetEmail = "spammed-target@example.com";
      // Same owner user, but a fresh business each time, so no single business's own
      // "one pending invitation per email" ConflictError rule is ever triggered.
      for (let i = 0; i < 5; i += 1) {
        const business = randomUUID();
        staffCtx.staffMembers.seed({ businessProfileId: business, userId: ownerUserId, role: "owner" });
        const response = await handlerFor()(
          postWithCookie({ businessProfileId: business, email: targetEmail, role: "manager" }, ownerToken),
        );
        expect(response.status).toBe(201);
      }
      const sixthBusiness = randomUUID();
      staffCtx.staffMembers.seed({ businessProfileId: sixthBusiness, userId: ownerUserId, role: "owner" });
      const sixth = await handlerFor()(
        postWithCookie({ businessProfileId: sixthBusiness, email: targetEmail, role: "manager" }, ownerToken),
      );
      expect(sixth.status).toBe(429);
    },
  );

  it("target-email limiting is case-insensitive", async () => {
    for (let i = 0; i < 5; i += 1) {
      const business = randomUUID();
      staffCtx.staffMembers.seed({ businessProfileId: business, userId: ownerUserId, role: "owner" });
      await handlerFor()(postWithCookie({ businessProfileId: business, email: "Case@Example.com", role: "manager" }, ownerToken));
    }
    const lastBusiness = randomUUID();
    staffCtx.staffMembers.seed({ businessProfileId: lastBusiness, userId: ownerUserId, role: "owner" });
    const sixth = await handlerFor()(
      postWithCookie({ businessProfileId: lastBusiness, email: "case@example.com", role: "manager" }, ownerToken),
    );
    expect(sixth.status).toBe(429);
  });
});
