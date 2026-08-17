import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("EmailDeliveryAdminService", () => {
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

  describe("authorization", () => {
    it("a non-privileged (member) user cannot list email delivery events", async () => {
      await expect(ctx.emailDeliveryAdminService.listRecent(randomUUID(), "member")).rejects.toThrow(ForbiddenError);
    });

    it("a platform_admin with no internal role assigned cannot list email delivery events", async () => {
      await expect(ctx.emailDeliveryAdminService.listRecent(randomUUID(), "platform_admin")).rejects.toThrow(ForbiddenError);
    });

    it("a support-role platform_admin CAN list email delivery events", async () => {
      const supportUserId = await makeSupportUser();
      await expect(ctx.emailDeliveryAdminService.listRecent(supportUserId, "platform_admin")).resolves.toEqual([]);
    });

    it("platform_owner bypasses the internal-role check entirely", async () => {
      await expect(ctx.emailDeliveryAdminService.listRecent(ownerUserId, "platform_owner")).resolves.toEqual([]);
    });

    it("a non-privileged (member) user cannot retry a failed email", async () => {
      await expect(
        ctx.emailDeliveryAdminService.retry({ notificationEventId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("listRecent", () => {
    it("returns recently created email-channel notification events", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.set("user-1", "user1@example.com");
      await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      const events = await ctx.emailDeliveryAdminService.listRecent(supportUserId, "platform_admin");
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.channel === "email")).toBe(true);
    });
  });

  describe("retry", () => {
    it("retries a failed email and records an audit event", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.set("user-1", "user1@example.com");
      ctx.notifyCtx.emailSender.failNext = true;
      const [record] = await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      expect(record.status).toBe("failed");

      const retried = await ctx.emailDeliveryAdminService.retry({ notificationEventId: record.id, actingUserId: supportUserId, actingRole: "platform_admin" });
      expect(retried.status).toBe("sent");
    });

    it("rejects retrying an event that is not currently failed", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.set("user-1", "user1@example.com");
      const [record] = await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      expect(record.status).toBe("sent");

      await expect(
        ctx.emailDeliveryAdminService.retry({ notificationEventId: record.id, actingUserId: supportUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
