import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("SupportCaseService", () => {
  let ctx: ReturnType<typeof createTestAdminOpsServices>;
  const ownerUserId = randomUUID();

  beforeEach(() => {
    ctx = createTestAdminOpsServices();
  });

  async function makeSupportUser(): Promise<string> {
    const userId = randomUUID();
    await ctx.adminRoleService.assignRole({ targetUserId: userId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
    return userId;
  }

  it("rejects a non-admin from opening a case (privilege escalation)", async () => {
    await expect(
      ctx.supportCaseService.openCase({ subjectUserId: randomUUID(), category: "billing", summary: "cannot log in", actingUserId: randomUUID(), actingRole: "member" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a fraud_reviewer (lacking manage_support_case) from opening a case", async () => {
    const fraudReviewerId = randomUUID();
    await ctx.adminRoleService.assignRole({ targetUserId: fraudReviewerId, role: "fraud_reviewer", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
    await expect(
      ctx.supportCaseService.openCase({ subjectUserId: randomUUID(), category: "billing", summary: "cannot log in", actingUserId: fraudReviewerId, actingRole: "platform_admin" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("a support-role admin can open, move through status, and close a case", async () => {
    const supportUserId = await makeSupportUser();
    const subjectUserId = randomUUID();
    const opened = await ctx.supportCaseService.openCase({ subjectUserId, category: "billing", summary: "cannot log in", actingUserId: supportUserId, actingRole: "platform_admin" });
    expect(opened.status).toBe("open");

    const inReview = await ctx.supportCaseService.updateStatus({ caseId: opened.id, status: "in_review", actingUserId: supportUserId, actingRole: "platform_admin" });
    expect(inReview.status).toBe("in_review");

    const closed = await ctx.supportCaseService.closeCase({ caseId: opened.id, resolutionNotes: "password reset sent", actingUserId: supportUserId, actingRole: "platform_admin" });
    expect(closed.status).toBe("closed");
    expect(closed.resolutionNotes).toBe("password reset sent");
  });

  it("rejects updating a case that is already closed", async () => {
    const supportUserId = await makeSupportUser();
    const opened = await ctx.supportCaseService.openCase({ subjectUserId: randomUUID(), category: null, summary: "issue", actingUserId: supportUserId, actingRole: "platform_admin" });
    await ctx.supportCaseService.closeCase({ caseId: opened.id, resolutionNotes: "done", actingUserId: supportUserId, actingRole: "platform_admin" });
    await expect(
      ctx.supportCaseService.updateStatus({ caseId: opened.id, status: "in_review", actingUserId: supportUserId, actingRole: "platform_admin" }),
    ).rejects.toThrow(ValidationError);
  });
});
