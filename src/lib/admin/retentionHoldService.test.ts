import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("RetentionHoldService", () => {
  let ctx: ReturnType<typeof createTestAdminOpsServices>;
  const ownerUserId = randomUUID();

  beforeEach(() => {
    ctx = createTestAdminOpsServices();
  });

  async function makeComplianceUser(): Promise<string> {
    const userId = randomUUID();
    await ctx.adminRoleService.assignRole({ targetUserId: userId, role: "compliance", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
    return userId;
  }

  describe("privilege escalation", () => {
    it("a non-privileged (member) user cannot place a hold", async () => {
      await expect(
        ctx.retentionHoldService.placeHold({
          targetResourceType: "agreement",
          targetResourceId: randomUUID(),
          holdType: "retention",
          reason: "seven-year policy",
          actingUserId: randomUUID(),
          actingRole: "member",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a non-privileged (member) user cannot release a hold", async () => {
      const complianceUserId = await makeComplianceUser();
      const hold = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId: randomUUID(),
        holdType: "litigation",
        reason: "active subpoena",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      await expect(
        ctx.retentionHoldService.releaseHold({ holdId: hold.id, actingUserId: randomUUID(), actingRole: "member", reason: null }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a platform_admin with an internal role that lacks the hold capabilities (e.g. support) is rejected", async () => {
      const supportUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: supportUserId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      await expect(
        ctx.retentionHoldService.placeHold({
          targetResourceType: "agreement",
          targetResourceId: randomUUID(),
          holdType: "retention",
          reason: "policy",
          actingUserId: supportUserId,
          actingRole: "platform_admin",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("retention hold behavior (mandatory per Sprint 18's own instruction)", () => {
    it("hasActiveHold is false before any hold, true once placed, and false again after release", async () => {
      const complianceUserId = await makeComplianceUser();
      const targetResourceId = randomUUID();
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(false);

      const hold = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId,
        holdType: "dispute",
        reason: "open dispute",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(true);

      await ctx.retentionHoldService.releaseHold({ holdId: hold.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: "dispute closed" });
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(false);
    });

    it("multiple simultaneous holds on the same target all must clear before hasActiveHold reports false", async () => {
      const complianceUserId = await makeComplianceUser();
      const targetResourceId = randomUUID();
      const holdA = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId,
        holdType: "dispute",
        reason: "open dispute",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      const holdB = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId,
        holdType: "litigation",
        reason: "active subpoena",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(true);

      await ctx.retentionHoldService.releaseHold({ holdId: holdA.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: null });
      // One of two holds released — still blocked.
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(true);

      await ctx.retentionHoldService.releaseHold({ holdId: holdB.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: null });
      // Both released — now clear.
      expect(await ctx.retentionHoldService.hasActiveHold("agreement", targetResourceId)).toBe(false);
    });

    it("hold placement and release are both audited", async () => {
      const complianceUserId = await makeComplianceUser();
      const hold = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId: randomUUID(),
        holdType: "fraud_review",
        reason: "suspicious activity",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      const events = await ctx.adminCaseReviewService.listAuditEventsForTarget({
        targetResourceType: "agreement",
        targetResourceId: hold.targetResourceId,
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      expect(events.some((e) => e.action === "retention_hold_placed")).toBe(true);

      await ctx.retentionHoldService.releaseHold({ holdId: hold.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: "resolved" });
      const eventsAfter = await ctx.adminCaseReviewService.listAuditEventsForTarget({
        targetResourceType: "agreement",
        targetResourceId: hold.targetResourceId,
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      expect(eventsAfter.some((e) => e.action === "retention_hold_released")).toBe(true);
    });

    it("rejects releasing an already-released hold", async () => {
      const complianceUserId = await makeComplianceUser();
      const hold = await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId: randomUUID(),
        holdType: "retention",
        reason: "policy",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      await ctx.retentionHoldService.releaseHold({ holdId: hold.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: null });
      await expect(
        ctx.retentionHoldService.releaseHold({ holdId: hold.id, actingUserId: complianceUserId, actingRole: "platform_admin", reason: null }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
