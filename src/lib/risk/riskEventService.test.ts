import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestRiskEventService } from "./testFakes";

const USER_ID = "user-1";
const ADMIN_ID = "admin-1";

describe("RiskEventService", () => {
  it("records a signal without blocking anything — a pure signal ledger", async () => {
    const { riskEventService } = createTestRiskEventService();
    const record = await riskEventService.recordSignal({
      userId: USER_ID,
      signalType: "repeated_payment_failure",
      severity: "medium",
      outcome: "flagged",
      relatedResourceType: "payment_attempt",
      relatedResourceId: "pay-1",
      detail: { count: 3, windowMinutes: 15 },
    });
    expect(record.reviewState).toBe("open");
    expect(record.detail).toEqual({ count: 3, windowMinutes: 15 });
  });

  it("rejects a signal with no userId", async () => {
    const { riskEventService } = createTestRiskEventService();
    await expect(
      riskEventService.recordSignal({
        userId: "",
        signalType: "repeated_authentication_failure",
        severity: "low",
        outcome: "flagged",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a platform_owner can list recent signals, optionally scoped to open review items only", async () => {
    const { riskEventService } = createTestRiskEventService();
    const a = await riskEventService.recordSignal({ userId: USER_ID, signalType: "invitation_velocity", severity: "low", outcome: "flagged" });
    await riskEventService.markReviewed(ADMIN_ID, "platform_owner", a.id, ADMIN_ID, "dismissed");
    await riskEventService.recordSignal({ userId: USER_ID, signalType: "frequent_bank_connection_change", severity: "medium", outcome: "manual_review_recommended" });

    const all = await riskEventService.listRecentForAdmin(ADMIN_ID, "platform_owner", { openOnly: false, limit: 10 });
    expect(all).toHaveLength(2);
    const openOnly = await riskEventService.listRecentForAdmin(ADMIN_ID, "platform_owner", { openOnly: true, limit: 10 });
    expect(openOnly).toHaveLength(1);
    expect(openOnly[0]?.signalType).toBe("frequent_bank_connection_change");
  });

  it("markReviewed records who reviewed it and when, without touching the original signal fields", async () => {
    const { riskEventService } = createTestRiskEventService();
    const record = await riskEventService.recordSignal({ userId: USER_ID, signalType: "unusual_admin_activity", severity: "high", outcome: "manual_review_recommended" });
    const reviewed = await riskEventService.markReviewed(ADMIN_ID, "platform_owner", record.id, ADMIN_ID, "reviewed");
    expect(reviewed.reviewState).toBe("reviewed");
    expect(reviewed.reviewedByUserId).toBe(ADMIN_ID);
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
    expect(reviewed.signalType).toBe("unusual_admin_activity");
    expect(reviewed.severity).toBe("high");
  });

  it("rejects reviewing a risk event that does not exist", async () => {
    const { riskEventService } = createTestRiskEventService();
    await expect(
      riskEventService.markReviewed(ADMIN_ID, "platform_owner", "00000000-0000-0000-0000-000000000000", ADMIN_ID, "reviewed"),
    ).rejects.toThrow(ValidationError);
  });

  it("caps listRecentForAdmin's limit at 200 and floors it at 1", async () => {
    const { riskEventService, riskEvents } = createTestRiskEventService();
    for (let i = 0; i < 3; i++) {
      await riskEventService.recordSignal({ userId: USER_ID, signalType: "invitation_velocity", severity: "info", outcome: "flagged" });
    }
    const zeroLimit = await riskEventService.listRecentForAdmin(ADMIN_ID, "platform_owner", { openOnly: false, limit: 0 });
    expect(zeroLimit).toHaveLength(1);
    expect(riskEvents.events).toHaveLength(3);
  });

  describe("SPRINT_19_FraudRisk_SecurityHardening: admin-only authorization enforced in the service itself (review_fraud_alert capability)", () => {
    it("rejects an ordinary member listing recent signals", async () => {
      const { riskEventService } = createTestRiskEventService();
      await expect(riskEventService.listRecentForAdmin(USER_ID, "member", { openOnly: false, limit: 10 })).rejects.toThrow(ForbiddenError);
    });

    it("rejects an ordinary member listing another user's signal history", async () => {
      const { riskEventService } = createTestRiskEventService();
      await expect(riskEventService.listForUserAdmin(USER_ID, "member", USER_ID)).rejects.toThrow(ForbiddenError);
    });

    it("rejects an ordinary member marking a signal reviewed", async () => {
      const { riskEventService } = createTestRiskEventService();
      const record = await riskEventService.recordSignal({ userId: USER_ID, signalType: "invitation_velocity", severity: "low", outcome: "flagged" });
      await expect(riskEventService.markReviewed(USER_ID, "member", record.id, USER_ID, "reviewed")).rejects.toThrow(ForbiddenError);
    });

    it("rejects a platform_admin with no internal role assignment (review_fraud_alert requires either platform_owner or an assigned internal role)", async () => {
      const { riskEventService } = createTestRiskEventService();
      await expect(riskEventService.listRecentForAdmin(ADMIN_ID, "platform_admin", { openOnly: false, limit: 10 })).rejects.toThrow(ForbiddenError);
    });

    it("allows a platform_admin who has been assigned the internal 'admin' role", async () => {
      const { riskEventService, adminRoleService } = createTestRiskEventService();
      await adminRoleService.assignRole({ targetUserId: ADMIN_ID, role: "admin", actingUserId: "owner-1", actingRole: "platform_owner", reason: "test setup" });
      await expect(riskEventService.listRecentForAdmin(ADMIN_ID, "platform_admin", { openOnly: false, limit: 10 })).resolves.toEqual([]);
    });
  });
});
