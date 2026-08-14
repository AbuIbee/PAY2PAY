import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("AdminCaseReviewService", () => {
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

  describe("getVerificationStatus — privilege escalation", () => {
    it("rejects a non-admin caller", async () => {
      await expect(
        ctx.adminCaseReviewService.getVerificationStatus({ profileKind: "personal", profileId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects an admin whose internal role lacks review_verification_status (e.g. support)", async () => {
      const supportUserId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: supportUserId, role: "support", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      await expect(
        ctx.adminCaseReviewService.getVerificationStatus({ profileKind: "personal", profileId: randomUUID(), actingUserId: supportUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a compliance-role admin reads the real underlying verification state via Sprint 3's own reader", async () => {
      const complianceUserId = await makeComplianceUser();
      const profileId = randomUUID();
      ctx.verification.set("personal", profileId, "FULL_VERIFIED");
      const state = await ctx.adminCaseReviewService.getVerificationStatus({ profileKind: "personal", profileId, actingUserId: complianceUserId, actingRole: "platform_admin" });
      expect(state).toBe("FULL_VERIFIED");
    });
  });

  describe("getAgreementDispute / getPaymentDispute — privilege escalation", () => {
    it("rejects a non-admin caller", async () => {
      await expect(
        ctx.adminCaseReviewService.getAgreementDispute({ disputeId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a compliance-role admin can read a dispute by id via the reused Sprint 16 repository (not the party-gated service)", async () => {
      const complianceUserId = await makeComplianceUser();
      const disputeId = randomUUID();
      ctx.disputes.agreementDisputes.set(disputeId, {
        id: disputeId,
        agreementId: randomUUID(),
        status: "opened",
        category: "incorrect_amount",
        explanation: "Amount is wrong.",
        raisedByRole: "debtor",
        raisedByProfileKind: "personal",
        raisedByProfileId: randomUUID(),
        raisedByUserId: randomUUID(),
        response: null,
        respondedByUserId: null,
        respondedAt: null,
        resolutionNotes: null,
        resolvedAt: null,
        resultingAmendmentId: null,
        restrictedReason: null,
        restrictedByUserId: null,
        restrictedAt: null,
        restrictionLiftedAt: null,
        closedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const dispute = await ctx.adminCaseReviewService.getAgreementDispute({ disputeId, actingUserId: complianceUserId, actingRole: "platform_admin" });
      expect(dispute?.id).toBe(disputeId);
    });
  });

  describe("listAuditEventsForTarget — privilege escalation", () => {
    it("rejects a non-admin caller", async () => {
      await expect(
        ctx.adminCaseReviewService.listAuditEventsForTarget({ targetResourceType: "agreement", targetResourceId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a compliance-role admin can list audit events for a target", async () => {
      const complianceUserId = await makeComplianceUser();
      const targetResourceId = randomUUID();
      await ctx.retentionHoldService.placeHold({
        targetResourceType: "agreement",
        targetResourceId,
        holdType: "retention",
        reason: "policy",
        actingUserId: complianceUserId,
        actingRole: "platform_admin",
      });
      const events = await ctx.adminCaseReviewService.listAuditEventsForTarget({ targetResourceType: "agreement", targetResourceId, actingUserId: complianceUserId, actingRole: "platform_admin" });
      expect(events.some((e) => e.action === "retention_hold_placed")).toBe(true);
    });
  });
});
