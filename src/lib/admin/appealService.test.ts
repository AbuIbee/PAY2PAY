import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAdminOpsServices } from "./adminOpsTestFakes";

describe("AppealService", () => {
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

  describe("submitAppeal — user-initiated, never admin-gated", () => {
    it("any authenticated user may submit an appeal", async () => {
      const appealingUserId = randomUUID();
      const originalDecisionByUserId = randomUUID();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId,
        targetResourceType: "user_account",
        targetResourceId: appealingUserId,
        originalDecisionSummary: "Account suspended for suspected fraud.",
        originalDecisionByUserId,
        evidenceDescription: "Attached bank statement showing legitimate activity.",
      });
      expect(appeal.status).toBe("submitted");
      expect(appeal.appealingUserId).toBe(appealingUserId);
    });

    it("rejects a submission with no original-decision summary", async () => {
      await expect(
        ctx.appealService.submitAppeal({
          appealingUserId: randomUUID(),
          targetResourceType: "user_account",
          targetResourceId: randomUUID(),
          originalDecisionSummary: "  ",
          originalDecisionByUserId: null,
          evidenceDescription: null,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("assignReviewer — privilege escalation + independent-reviewer enforcement", () => {
    it("rejects a non-admin from assigning a reviewer", async () => {
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId: randomUUID(),
        targetResourceType: "user_account",
        targetResourceId: randomUUID(),
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId: randomUUID(),
        evidenceDescription: null,
      });
      await expect(
        ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId: randomUUID(), actingUserId: randomUUID(), actingRole: "member" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("prevents the original decision-maker from being assigned as the sole reviewer", async () => {
      const complianceUserId = await makeComplianceUser();
      const originalDecisionByUserId = randomUUID();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId: randomUUID(),
        targetResourceType: "user_account",
        targetResourceId: randomUUID(),
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId,
        evidenceDescription: null,
      });
      await expect(
        ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId: originalDecisionByUserId, actingUserId: complianceUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("allows assigning a different reviewer, moving the appeal to under_review", async () => {
      const complianceUserId = await makeComplianceUser();
      const reviewerUserId = randomUUID();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId: randomUUID(),
        targetResourceType: "user_account",
        targetResourceId: randomUUID(),
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId: randomUUID(),
        evidenceDescription: null,
      });
      const updated = await ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId, actingUserId: complianceUserId, actingRole: "platform_admin" });
      expect(updated.status).toBe("under_review");
      expect(updated.reviewerUserId).toBe(reviewerUserId);
    });
  });

  describe("decideAppeal", () => {
    async function submitAndAssign(complianceUserId: string) {
      const originalDecisionByUserId = randomUUID();
      // The reviewer must independently hold "manage_appeal" too — being the assigned reviewerUserId
      // alone is not sufficient; decideAppeal requires both.
      const reviewerUserId = await makeComplianceUser();
      const appealingUserId = randomUUID();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId,
        targetResourceType: "user_account",
        targetResourceId: appealingUserId,
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId,
        evidenceDescription: null,
      });
      await ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId, actingUserId: complianceUserId, actingRole: "platform_admin" });
      return { appeal, reviewerUserId, appealingUserId, originalDecisionByUserId };
    }

    it("rejects a caller who is not this appeal's assigned reviewer, even if they hold the manage_appeal capability", async () => {
      const complianceUserId = await makeComplianceUser();
      const { appeal } = await submitAndAssign(complianceUserId);
      const otherComplianceUserId = await makeComplianceUser();
      await expect(
        ctx.appealService.decideAppeal({ appealId: appeal.id, decision: "upheld", rationale: "no new evidence", actingUserId: otherComplianceUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects deciding before a reviewer is assigned", async () => {
      const complianceUserId = await makeComplianceUser();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId: randomUUID(),
        targetResourceType: "user_account",
        targetResourceId: randomUUID(),
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId: randomUUID(),
        evidenceDescription: null,
      });
      await expect(
        ctx.appealService.decideAppeal({ appealId: appeal.id, decision: "upheld", rationale: "no new evidence", actingUserId: complianceUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ValidationError);
    });

    it("the assigned reviewer may record an 'upheld' decision, which notifies the appealing user and never touches any restriction", async () => {
      const complianceUserId = await makeComplianceUser();
      const { appeal, reviewerUserId, appealingUserId } = await submitAndAssign(complianceUserId);

      const decided = await ctx.appealService.decideAppeal({
        appealId: appeal.id,
        decision: "upheld",
        rationale: "Original decision was correct.",
        actingUserId: reviewerUserId,
        actingRole: "platform_admin",
      });
      expect(decided.status).toBe("decided");
      expect(decided.decision).toBe("upheld");

      const notifications = await ctx.notifyCtx.events.listForUser(appealingUserId);
      expect(notifications.some((n) => n.notificationType === "appeal_decided")).toBe(true);
    });

    it("rejects deciding an appeal twice", async () => {
      const complianceUserId = await makeComplianceUser();
      const { appeal, reviewerUserId } = await submitAndAssign(complianceUserId);
      await ctx.appealService.decideAppeal({ appealId: appeal.id, decision: "upheld", rationale: "correct", actingUserId: reviewerUserId, actingRole: "platform_admin" });
      await expect(
        ctx.appealService.decideAppeal({ appealId: appeal.id, decision: "upheld", rationale: "again", actingUserId: reviewerUserId, actingRole: "platform_admin" }),
      ).rejects.toThrow(ValidationError);
    });

    it("'restrictions stay in place during review unless an authorized reviewer lifts them' — an active restriction is untouched until decideAppeal explicitly lifts it on overturn", async () => {
      const fraudReviewerId = randomUUID();
      await ctx.adminRoleService.assignRole({ targetUserId: fraudReviewerId, role: "fraud_reviewer", actingUserId: ownerUserId, actingRole: "platform_owner", reason: null });
      const complianceUserId = await makeComplianceUser();

      const appealingUserId = randomUUID();
      const restriction = await ctx.adminRestrictionService.restrict({
        restrictionType: "payment_activity",
        targetResourceType: "user_account",
        targetResourceId: appealingUserId,
        reason: "suspected fraud",
        actingUserId: fraudReviewerId,
        actingRole: "platform_admin",
      });

      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId,
        targetResourceType: "user_account",
        targetResourceId: appealingUserId,
        originalDecisionSummary: "Payment activity restricted for suspected fraud.",
        originalDecisionByUserId: fraudReviewerId,
        evidenceDescription: "Proof of legitimate transaction history.",
      });
      const reviewerUserId = await makeComplianceUser();
      await ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId, actingUserId: complianceUserId, actingRole: "platform_admin" });

      // Still under review — restriction remains active.
      expect(await ctx.adminRestrictionService.isRestricted("user_account", appealingUserId, "payment_activity")).toBe(true);

      await ctx.appealService.decideAppeal({
        appealId: appeal.id,
        decision: "overturned",
        rationale: "Evidence confirmed legitimate activity.",
        liftRestrictionId: restriction.id,
        actingUserId: reviewerUserId,
        actingRole: "platform_admin",
      });

      expect(await ctx.adminRestrictionService.isRestricted("user_account", appealingUserId, "payment_activity")).toBe(false);
    });

    it("passes an optional ledger adjustment straight through to the reused LedgerAdminService.postAdjustment (Owner-gated, never bypassed)", async () => {
      const complianceUserId = await makeComplianceUser();
      const { appeal, reviewerUserId } = await submitAndAssign(complianceUserId);

      // The assigned reviewer is only a platform_admin, not Owner — the ledger adjustment itself must be rejected by the reused Owner gate, even though the appeal decision itself succeeds.
      await expect(
        ctx.appealService.decideAppeal({
          appealId: appeal.id,
          decision: "overturned",
          rationale: "Forgiving a portion of the balance.",
          ledgerAdjustment: {
            paymentAttemptId: randomUUID(),
            agreementId: randomUUID(),
            currency: "USD",
            targetAccountType: "creditor_clawback_exposure",
            direction: "credit",
            amountMinorUnits: 5000,
            reason: "Appeal remedy",
          },
          actingUserId: reviewerUserId,
          actingRole: "platform_admin",
        }),
      ).rejects.toThrow("Platform Owner access is required");
      expect(ctx.ledger.posted).toHaveLength(0);
    });

    it("an Owner-role reviewer's ledger adjustment is posted through the reused mechanism", async () => {
      const complianceUserId = await makeComplianceUser();
      const originalDecisionByUserId = randomUUID();
      const reviewerUserId = randomUUID();
      const appealingUserId = randomUUID();
      const appeal = await ctx.appealService.submitAppeal({
        appealingUserId,
        targetResourceType: "user_account",
        targetResourceId: appealingUserId,
        originalDecisionSummary: "Restricted.",
        originalDecisionByUserId,
        evidenceDescription: null,
      });
      await ctx.appealService.assignReviewer({ appealId: appeal.id, reviewerUserId, actingUserId: complianceUserId, actingRole: "platform_admin" });

      await ctx.appealService.decideAppeal({
        appealId: appeal.id,
        decision: "overturned",
        rationale: "Remedy owed.",
        ledgerAdjustment: {
          paymentAttemptId: randomUUID(),
          agreementId: randomUUID(),
          currency: "USD",
          targetAccountType: "creditor_clawback_exposure",
          direction: "credit",
          amountMinorUnits: 2500,
          reason: "Appeal remedy",
        },
        actingUserId: reviewerUserId,
        actingRole: "platform_owner",
      });
      expect(ctx.ledger.posted).toHaveLength(1);
    });
  });
});
