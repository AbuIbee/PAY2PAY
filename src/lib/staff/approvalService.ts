import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { MfaService } from "@/lib/auth/mfaService";
import { ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import type { Capability } from "./capabilities";
import { isCapability } from "./capabilities";
import type { StaffService } from "./staffService";

export interface BusinessApprovalPolicyRecord {
  id: string;
  businessProfileId: string;
  capability: Capability;
  thresholdMinorUnits: number | null;
  requiresDualApproval: boolean;
  requiresOwner: boolean;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleBusinessApprovalPolicyRepository. */
export interface BusinessApprovalPolicyRepository {
  /** Inserts, or replaces the existing row for this (business, capability) — one policy per capability per business. */
  upsert(input: {
    businessProfileId: string;
    capability: Capability;
    thresholdMinorUnits: number | null;
    requiresDualApproval: boolean;
    requiresOwner: boolean;
    updatedByUserId: string;
  }): Promise<BusinessApprovalPolicyRecord>;
  findByBusinessAndCapability(businessProfileId: string, capability: Capability): Promise<BusinessApprovalPolicyRecord | null>;
  listByBusiness(businessProfileId: string): Promise<BusinessApprovalPolicyRecord[]>;
}

export type ApprovalRequestStatus = "pending" | "approved" | "rejected";

export interface StaffApprovalRequestRecord {
  id: string;
  businessProfileId: string;
  proposedByStaffId: string;
  relatedAgreementId: string | null;
  actionType: Capability;
  actionPayload: unknown;
  reasonFlagged: string;
  status: ApprovalRequestStatus;
  approvedByStaffId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** Real implementation: DrizzleStaffApprovalRequestRepository. */
export interface StaffApprovalRequestRepository {
  insert(input: {
    businessProfileId: string;
    proposedByStaffId: string;
    relatedAgreementId: string | null;
    actionType: Capability;
    actionPayload: unknown;
    reasonFlagged: string;
  }): Promise<StaffApprovalRequestRecord>;
  findById(id: string): Promise<StaffApprovalRequestRecord | null>;
  updateDecision(
    id: string,
    input: { status: "approved" | "rejected"; approvedByStaffId: string; decidedAt: Date },
  ): Promise<void>;
  /** Sprint 18B: the pending-approval queue UI needs a list, not just findById — read-only, no new business rule. */
  listPendingByBusiness(businessProfileId: string): Promise<StaffApprovalRequestRecord[]>;
}

export interface ProposalOutcome {
  /** false = the action's policy (if any) is satisfied and the caller may proceed immediately, no approval needed. */
  requiresApproval: boolean;
  request: StaffApprovalRequestRecord | null;
}

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md): "settlement
 * approval limits, balance-adjustment limits, two-person approval
 * configuration, owner-required thresholds." Built on top of StaffService's
 * capability checks rather than duplicating them — proposing or deciding an
 * action still requires actually holding that action's capability; the
 * policy layer here only adds a *second* gate on top for high-value/
 * sensitive amounts, never a way around the first gate.
 *
 * "Two-person approval" falls directly out of this table's shape: exactly
 * one proposer and, if required, one *different* approver
 * (staff_approval_request's no-self-approval CHECK, mirrored in
 * decideAction below) — there is no path to a single person satisfying both
 * roles.
 */
export class ApprovalService {
  constructor(
    private readonly policies: BusinessApprovalPolicyRepository,
    private readonly requests: StaffApprovalRequestRepository,
    private readonly staffService: StaffService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {}

  /** Read-only; callers are expected to have already checked staff membership (see the API route). */
  async listPolicies(businessProfileId: string): Promise<BusinessApprovalPolicyRecord[]> {
    return this.policies.listByBusiness(businessProfileId);
  }

  /** Read-only; callers are expected to have already checked staff membership (see the API route) — same convention as listPolicies. */
  async listPendingRequests(businessProfileId: string): Promise<StaffApprovalRequestRecord[]> {
    return this.requests.listPendingByBusiness(businessProfileId);
  }

  async setApprovalPolicy(input: {
    businessProfileId: string;
    actingUserId: string;
    actingSessionId: string;
    capability: string;
    thresholdMinorUnits: number | null;
    requiresDualApproval: boolean;
    requiresOwner: boolean;
  }): Promise<BusinessApprovalPolicyRecord> {
    if (!isCapability(input.capability)) {
      throw new ValidationError(`"${input.capability}" is not a recognized capability.`);
    }
    if (input.thresholdMinorUnits !== null && (!Number.isInteger(input.thresholdMinorUnits) || input.thresholdMinorUnits < 0)) {
      throw new ValidationError("thresholdMinorUnits must be a non-negative integer or null.");
    }

    // Threshold/approval-configuration changes are a high-risk change per
    // this sprint's text — gated the same way as staff role changes and
    // custom-role edits (manage_staff + a fresh step-up), not a bare
    // capability check alone.
    await this.staffService.requireCapability(input.businessProfileId, input.actingUserId, "manage_staff");
    const stepUpOk = await this.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "approval_policy_change",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to change an approval policy.");
    }

    const policy = await this.policies.upsert({
      businessProfileId: input.businessProfileId,
      capability: input.capability,
      thresholdMinorUnits: input.thresholdMinorUnits,
      requiresDualApproval: input.requiresDualApproval,
      requiresOwner: input.requiresOwner,
      updatedByUserId: input.actingUserId,
    });

    await this.recordAudit(input.businessProfileId, input.actingUserId, "approval_policy_updated", "step_up", {
      capability: input.capability,
      thresholdMinorUnits: input.thresholdMinorUnits,
      requiresDualApproval: input.requiresDualApproval,
      requiresOwner: input.requiresOwner,
    });
    return policy;
  }

  /**
   * The seam a capability-gated action (e.g. settlement approval, balance
   * adjustment) calls before executing. Returns requiresApproval: false when
   * no policy applies or the policy's conditions aren't triggered by this
   * specific amount — the caller proceeds immediately. Otherwise a pending
   * staff_approval_request is created and the caller must wait for
   * decideAction.
   */
  async proposeAction(input: {
    businessProfileId: string;
    proposedByUserId: string;
    actionType: string;
    amountMinorUnits: number | null;
    relatedAgreementId: string | null;
    actionPayload: unknown;
  }): Promise<ProposalOutcome> {
    if (!isCapability(input.actionType)) {
      throw new ValidationError(`"${input.actionType}" is not a recognized capability.`);
    }
    // A staff member may only propose an action their own role/custom role
    // actually grants — the policy layer narrows further, it never widens.
    const proposer = await this.staffService.requireCapability(
      input.businessProfileId,
      input.proposedByUserId,
      input.actionType,
    );

    const policy = await this.policies.findByBusinessAndCapability(input.businessProfileId, input.actionType);
    const reason = policy ? this.evaluatePolicyTrigger(policy, input.amountMinorUnits) : null;
    if (!policy || !reason) {
      return { requiresApproval: false, request: null };
    }

    const request = await this.requests.insert({
      businessProfileId: input.businessProfileId,
      proposedByStaffId: proposer.id,
      relatedAgreementId: input.relatedAgreementId,
      actionType: input.actionType,
      actionPayload: input.actionPayload,
      reasonFlagged: reason,
    });

    await this.recordAudit(input.businessProfileId, input.proposedByUserId, "approval_requested", null, {
      requestId: request.id,
      actionType: input.actionType,
      reason,
    });
    return { requiresApproval: true, request };
  }

  async decideAction(input: {
    businessProfileId: string;
    decidingUserId: string;
    requestId: string;
    decision: "approved" | "rejected";
  }): Promise<StaffApprovalRequestRecord> {
    const request = await this.requests.findById(input.requestId);
    if (!request || request.businessProfileId !== input.businessProfileId) {
      throw new ForbiddenError("This approval request does not belong to this business.");
    }
    if (request.status !== "pending") {
      throw new ValidationError("This approval request has already been decided.");
    }

    const decider = await this.staffService.requireCapability(
      input.businessProfileId,
      input.decidingUserId,
      request.actionType,
    );

    // No-self-approval — the same invariant the DB CHECK enforces, checked
    // here first for a clean 403 instead of a constraint-violation error.
    if (decider.id === request.proposedByStaffId) {
      throw new ForbiddenError("You cannot approve or reject your own request.");
    }

    const policy = await this.policies.findByBusinessAndCapability(input.businessProfileId, request.actionType);
    if (policy?.requiresOwner && decider.role !== "owner") {
      throw new ForbiddenError("Only an owner may decide this request.");
    }

    const decidedAt = new Date();
    await this.requests.updateDecision(request.id, {
      status: input.decision,
      approvedByStaffId: decider.id,
      decidedAt,
    });

    await this.recordAudit(input.businessProfileId, input.decidingUserId, "approval_decided", null, {
      requestId: request.id,
      decision: input.decision,
    });

    return { ...request, status: input.decision, approvedByStaffId: decider.id, decidedAt };
  }

  private evaluatePolicyTrigger(policy: BusinessApprovalPolicyRecord, amountMinorUnits: number | null): string | null {
    if (policy.requiresOwner) return "owner_required_threshold";
    if (policy.requiresDualApproval) return "dual_approval_required";
    if (policy.thresholdMinorUnits !== null && (amountMinorUnits ?? 0) > policy.thresholdMinorUnits) {
      return `amount_exceeds_threshold:${policy.thresholdMinorUnits}`;
    }
    return null;
  }

  private async recordAudit(
    businessProfileId: string,
    actorUserId: string,
    action: string,
    authStrength: string | null,
    newValue: unknown,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      actorRole: "business_staff",
      profileKind: "business",
      profileId: businessProfileId,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
