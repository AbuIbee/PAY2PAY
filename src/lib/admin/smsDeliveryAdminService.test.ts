import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("SmsDeliveryAdminService", () => {
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
    it("a non-privileged (member) user cannot list SMS delivery events", async () => {
      await expect(ctx.smsDeliveryAdminService.listRecent(randomUUID(), "member")).rejects.toThrow(ForbiddenError);
    });

    it("a platform_admin with no internal role assigned cannot list SMS delivery events", async () => {
      await expect(ctx.smsDeliveryAdminService.listRecent(randomUUID(), "platform_admin")).rejects.toThrow(ForbiddenError);
    });

    it("a support-role platform_admin CAN list SMS delivery events", async () => {
      const supportUserId = await makeSupportUser();
      await expect(ctx.smsDeliveryAdminService.listRecent(supportUserId, "platform_admin")).resolves.toEqual([]);
    });

    it("platform_owner bypasses the internal-role check entirely", async () => {
      await expect(ctx.smsDeliveryAdminService.listRecent(ownerUserId, "platform_owner")).resolves.toEqual([]);
    });

    it("a non-privileged (member) user cannot retry a failed SMS", async () => {
      await expect(
        ctx.smsDeliveryAdminService.retry({ notificationEventId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("listRecent", () => {
    it("returns recently created sms-channel notification events", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.setPhone("user-1", "+15551234567");
      await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const events = await ctx.smsDeliveryAdminService.listRecent(supportUserId, "platform_admin");
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.channel === "sms")).toBe(true);
    });
  });

  describe("retry", () => {
    it("retries a failed SMS and records an audit event", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.setPhone("user-1", "+15551234567");
      ctx.notifyCtx.smsSender.failNext = true;
      const records = await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const record = records.find((r) => r.channel === "sms")!;
      expect(record.status).toBe("failed");

      const retried = await ctx.smsDeliveryAdminService.retry({ notificationEventId: record.id, actingUserId: supportUserId, actingRole: "platform_admin" });
      expect(retried.status).toBe("sent");
    });

    it("rejects retrying an event that is not currently failed", async () => {
      const supportUserId = await makeSupportUser();
      ctx.notifyCtx.contacts.setPhone("user-1", "+15551234567");
      const records = await ctx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const record = records.find((r) => r.channel === "sms")!;
      expect(record.status).toBe("sent");

      await expect(
        ctx.smsDeliveryAdminService.retry({ notificationEventId: record.id, actingUserId: supportUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
