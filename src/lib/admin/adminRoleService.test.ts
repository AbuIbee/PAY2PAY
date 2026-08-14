import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("AdminRoleService", () => {
  let ctx: ReturnType<typeof createTestAdminOpsServices>;

  beforeEach(() => {
    ctx = createTestAdminOpsServices();
  });

  describe("assignRole / revokeRole — privilege escalation", () => {
    it("rejects a non-admin caller from assigning any internal role", async () => {
      await expect(
        ctx.adminRoleService.assignRole({ targetUserId: randomUUID(), role: "support", actingUserId: randomUUID(), actingRole: "member", reason: null }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects a plain platform_admin (not Owner) from assigning an internal role", async () => {
      await expect(
        ctx.adminRoleService.assignRole({ targetUserId: randomUUID(), role: "support", actingUserId: randomUUID(), actingRole: "platform_admin", reason: null }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("allows a platform_owner to assign and later revoke an internal role", async () => {
      const targetUserId = randomUUID();
      const ownerUserId = randomUUID();
      const assignment = await ctx.adminRoleService.assignRole({ targetUserId, role: "compliance", actingUserId: ownerUserId, actingRole: "platform_owner", reason: "onboarding" });
      expect(assignment.role).toBe("compliance");
      expect(await ctx.adminRoleService.getActiveRole(targetUserId)).toBe("compliance");

      const revoked = await ctx.adminRoleService.revokeRole({ assignmentId: assignment.id, actingUserId: ownerUserId, actingRole: "platform_owner", reason: "role change" });
      expect(revoked.revokedAt).not.toBeNull();
      expect(await ctx.adminRoleService.getActiveRole(targetUserId)).toBeNull();
    });

    it("rejects assigning a second active role to a user who already has one", async () => {
      const targetUserId = randomUUID();
      const ownerUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      await expect(
        ctx.adminRoleService.assignRole({ targetUserId, role: "fraud_reviewer", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("requireCapability — the shared authorization primitive", () => {
    it("rejects a member (not even a platform_admin) outright", async () => {
      await expect(ctx.adminRoleService.requireCapability(randomUUID(), "member", "manage_support_case")).rejects.toThrow(ForbiddenError);
    });

    it("rejects a platform_admin with no internal role assignment at all", async () => {
      await expect(ctx.adminRoleService.requireCapability(randomUUID(), "platform_admin", "manage_support_case")).rejects.toThrow(ForbiddenError);
    });

    it("rejects a platform_admin whose assigned internal role does not include the requested capability", async () => {
      const userId = randomUUID();
      const ownerUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: userId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      // "support" has manage_support_case but not restrict_payment_activity.
      await expect(ctx.adminRoleService.requireCapability(userId, "platform_admin", "restrict_payment_activity")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminRoleService.requireCapability(userId, "platform_admin", "manage_support_case")).resolves.toBeUndefined();
    });

    it("allows a platform_admin whose internal role is 'admin' every capability, without needing DEFAULT_INTERNAL_ROLE_CAPABILITIES to list them", async () => {
      const userId = randomUUID();
      const ownerUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: userId, role: "admin", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      await expect(ctx.adminRoleService.requireCapability(userId, "platform_admin", "restrict_payment_activity")).resolves.toBeUndefined();
      await expect(ctx.adminRoleService.requireCapability(userId, "platform_admin", "place_retention_hold")).resolves.toBeUndefined();
      await expect(ctx.adminRoleService.requireCapability(userId, "platform_admin", "manage_appeal")).resolves.toBeUndefined();
    });

    it("allows a platform_owner every capability even with no internal role assignment at all", async () => {
      await expect(ctx.adminRoleService.requireCapability(randomUUID(), "platform_owner", "restrict_payment_activity")).resolves.toBeUndefined();
      await expect(ctx.adminRoleService.requireCapability(randomUUID(), "platform_owner", "manage_appeal")).resolves.toBeUndefined();
    });
  });
});
