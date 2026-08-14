import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createTestApprovalService, createTestStaffService, grantStepUp } from "./testFakes";

const BUSINESS_A = randomUUID();

describe("ApprovalService", () => {
  let staffCtx: ReturnType<typeof createTestStaffService>;
  let approvalCtx: ReturnType<typeof createTestApprovalService>;
  let ownerUserId: string;
  let managerUserId: string;
  let secondManagerUserId: string;

  beforeEach(async () => {
    staffCtx = createTestStaffService();
    approvalCtx = createTestApprovalService(staffCtx.staffService, staffCtx.mfaService);

    ownerUserId = randomUUID();
    managerUserId = randomUUID();
    secondManagerUserId = randomUUID();
    staffCtx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: ownerUserId, role: "owner" });
    staffCtx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: managerUserId, role: "manager" });
    staffCtx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: secondManagerUserId, role: "manager" });

    await grantStepUp(staffCtx, ownerUserId, "owner-session");
    await approvalCtx.approvalService.setApprovalPolicy({
      businessProfileId: BUSINESS_A,
      actingUserId: ownerUserId,
      actingSessionId: "owner-session",
      capability: "approve_partial_payment",
      thresholdMinorUnits: 10_000,
      requiresDualApproval: false,
      requiresOwner: false,
    });
  });

  it("threshold enforcement: an amount under the threshold proceeds without an approval request", async () => {
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: managerUserId,
      actionType: "approve_partial_payment",
      amountMinorUnits: 5_000,
      relatedAgreementId: null,
      actionPayload: { note: "small payment" },
    });
    expect(outcome.requiresApproval).toBe(false);
    expect(outcome.request).toBeNull();
  });

  it("threshold enforcement: an amount over the threshold creates a pending approval request", async () => {
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: managerUserId,
      actionType: "approve_partial_payment",
      amountMinorUnits: 25_000,
      relatedAgreementId: null,
      actionPayload: { note: "large payment" },
    });
    expect(outcome.requiresApproval).toBe(true);
    expect(outcome.request?.status).toBe("pending");
    expect(outcome.request?.reasonFlagged).toContain("amount_exceeds_threshold");
  });

  it("dual approval: the proposer cannot approve their own request", async () => {
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: managerUserId,
      actionType: "approve_partial_payment",
      amountMinorUnits: 25_000,
      relatedAgreementId: null,
      actionPayload: {},
    });

    await expect(
      approvalCtx.approvalService.decideAction({
        businessProfileId: BUSINESS_A,
        decidingUserId: managerUserId,
        requestId: outcome.request!.id,
        decision: "approved",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("dual approval: a different staff member with the same capability can approve", async () => {
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: managerUserId,
      actionType: "approve_partial_payment",
      amountMinorUnits: 25_000,
      relatedAgreementId: null,
      actionPayload: {},
    });

    const decided = await approvalCtx.approvalService.decideAction({
      businessProfileId: BUSINESS_A,
      decidingUserId: secondManagerUserId,
      requestId: outcome.request!.id,
      decision: "approved",
    });
    expect(decided.status).toBe("approved");
    expect(decided.approvedByStaffId).not.toBe(outcome.request!.proposedByStaffId);
  });

  it("owner-required thresholds: a non-owner cannot decide a request whose policy requires an owner", async () => {
    await approvalCtx.approvalService.setApprovalPolicy({
      businessProfileId: BUSINESS_A,
      actingUserId: ownerUserId,
      actingSessionId: "owner-session",
      capability: "forgive_principal",
      thresholdMinorUnits: null,
      requiresDualApproval: false,
      requiresOwner: true,
    });
    // The owner has every capability, including forgive_principal, so it can propose.
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: ownerUserId,
      actionType: "forgive_principal",
      amountMinorUnits: null,
      relatedAgreementId: null,
      actionPayload: {},
    });
    expect(outcome.requiresApproval).toBe(true);

    // A manager lacks forgive_principal entirely, so requireCapability rejects before the owner-required check.
    await expect(
      approvalCtx.approvalService.decideAction({
        businessProfileId: BUSINESS_A,
        decidingUserId: managerUserId,
        requestId: outcome.request!.id,
        decision: "approved",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("listPendingRequests returns only this business's pending requests, oldest last", async () => {
    const outcome = await approvalCtx.approvalService.proposeAction({
      businessProfileId: BUSINESS_A,
      proposedByUserId: managerUserId,
      actionType: "approve_partial_payment",
      amountMinorUnits: 50_000,
      relatedAgreementId: null,
      actionPayload: { note: "large payment" },
    });
    expect(outcome.requiresApproval).toBe(true);

    const pending = await approvalCtx.approvalService.listPendingRequests(BUSINESS_A);
    expect(pending.map((r) => r.id)).toContain(outcome.request!.id);
    expect(pending.every((r) => r.status === "pending")).toBe(true);

    await approvalCtx.approvalService.decideAction({
      businessProfileId: BUSINESS_A,
      decidingUserId: ownerUserId,
      requestId: outcome.request!.id,
      decision: "approved",
    });
    const afterDecision = await approvalCtx.approvalService.listPendingRequests(BUSINESS_A);
    expect(afterDecision.map((r) => r.id)).not.toContain(outcome.request!.id);
  });

  it("approval policy changes are audited and require step-up", async () => {
    expect(approvalCtx.auditRepo.events.map((e) => e.action)).toContain("approval_policy_updated");

    await expect(
      approvalCtx.approvalService.setApprovalPolicy({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "session-without-step-up",
        capability: "approve_settlement",
        thresholdMinorUnits: 50_000,
        requiresDualApproval: false,
        requiresOwner: false,
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
