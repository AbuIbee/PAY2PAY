import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("AdminRestrictionService", () => {
  let ctx: ReturnType<typeof createTestAdminOpsServices>;
  const ownerUserId = randomUUID();

  beforeEach(() => {
    ctx = createTestAdminOpsServices();
  });

  async function makeFraudReviewer(): Promise<string> {
    const userId = randomUUID();
    await ctx.adminRoleService.assignRole({ targetUserId: userId, role: "fraud_reviewer", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
    return userId;
  }

  describe("privilege escalation", () => {
    it("a member cannot place any restriction", async () => {
      await expect(
        ctx.adminRestrictionService.restrict({
          restrictionType: "payment_activity",
          targetResourceType: "user_account",
          targetResourceId: randomUUID(),
          reason: "suspected fraud",
          actingUserId: randomUUID(),
          actingRole: "member",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a support-role admin (lacking restriction capabilities) cannot place a payout restriction", async () => {
      const supportUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: supportUserId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      await expect(
        ctx.adminRestrictionService.restrict({
          restrictionType: "payout",
          targetResourceType: "business_profile",
          targetResourceId: randomUUID(),
          reason: "processor hold",
          actingUserId: supportUserId,
          actingRole: "platform_admin",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a fraud_reviewer may place and lift all three restriction types", async () => {
      const fraudReviewerId = await makeFraudReviewer();
      const targetResourceId = randomUUID();
      for (const restrictionType of ["payment_activity", "new_agreement_creation", "payout"] as const) {
        const restriction = await ctx.adminRestrictionService.restrict({
          restrictionType,
          targetResourceType: "user_account",
          targetResourceId,
          reason: "under review",
          actingUserId: fraudReviewerId,
          actingRole: "platform_admin",
        });
        expect(await ctx.adminRestrictionService.isRestricted("user_account", targetResourceId, restrictionType)).toBe(true);
        await ctx.adminRestrictionService.lift({ restrictionId: restriction.id, actingUserId: fraudReviewerId, actingRole: "platform_admin", reason: "cleared" });
        expect(await ctx.adminRestrictionService.isRestricted("user_account", targetResourceId, restrictionType)).toBe(false);
      }
    });
  });

  describe("restriction lifecycle", () => {
    it("rejects a second active restriction of the same type on the same target", async () => {
      const fraudReviewerId = await makeFraudReviewer();
      const targetResourceId = randomUUID();
      await ctx.adminRestrictionService.restrict({
        restrictionType: "payment_activity",
        targetResourceType: "user_account",
        targetResourceId,
        reason: "first",
        actingUserId: fraudReviewerId,
        actingRole: "platform_admin",
      });
      await expect(
        ctx.adminRestrictionService.restrict({
          restrictionType: "payment_activity",
          targetResourceType: "user_account",
          targetResourceId,
          reason: "second",
          actingUserId: fraudReviewerId,
          actingRole: "platform_admin",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects lifting an already-lifted restriction", async () => {
      const fraudReviewerId = await makeFraudReviewer();
      const restriction = await ctx.adminRestrictionService.restrict({
        restrictionType: "new_agreement_creation",
        targetResourceType: "user_account",
        targetResourceId: randomUUID(),
        reason: "under review",
        actingUserId: fraudReviewerId,
        actingRole: "platform_admin",
      });
      await ctx.adminRestrictionService.lift({ restrictionId: restriction.id, actingUserId: fraudReviewerId, actingRole: "platform_admin", reason: null });
      await expect(
        ctx.adminRestrictionService.lift({ restrictionId: restriction.id, actingUserId: fraudReviewerId, actingRole: "platform_admin", reason: null }),
      ).rejects.toThrow(ValidationError);
    });

    it("isRestricted is false for a target that was never restricted", async () => {
      expect(await ctx.adminRestrictionService.isRestricted("agreement", randomUUID(), "payment_activity")).toBe(false);
    });
  });
});
