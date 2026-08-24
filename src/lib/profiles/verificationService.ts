import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { AdminRoleService } from "@/lib/admin/adminRoleService";
import type { PlatformRole } from "@/lib/auth/authService";
import { ConflictError, ValidationError } from "@/lib/errors";

export type ProfileKind = "personal" | "business";
export type VerificationTier = "basic" | "full";
export type VerificationRecordStatus = "pending" | "verified" | "rejected";
export type VerificationState = "UNVERIFIED" | "BASIC" | "FULL_PENDING" | "FULL_VERIFIED" | "FULL_REJECTED";

export interface IdentityVerificationRecordRecord {
  id: string;
  profileKind: ProfileKind;
  profileId: string;
  tier: VerificationTier;
  status: VerificationRecordStatus;
  reviewerUserId: string | null;
  // Sprint 9: the KYC/KYB provider's own verification id for this attempt, reserved on this column
  // since Sprint 3 (src/db/schema/verification.ts's `provider_ref`). Null until
  // recordProviderSubmission attaches it; used by the provider webhook to resolve an inbound event
  // back to a profile via findByProviderRef, without providerPaymentId/providerVerificationId ever
  // becoming a join key anywhere else (Sprint 9's "external references, not primary identifiers").
  providerRef: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) identity
 * verification architecture. This is the *only* write path to this data —
 * there is no column on personal_profile/business_profile a caller could
 * flip directly (see src/db/schema/identity.ts's doc comments), so
 * "verification status cannot self-report as FULL_VERIFIED" is structural,
 * not just a runtime check that could have a bug in it.
 */
export interface IdentityVerificationRecordRepository {
  insert(input: {
    profileKind: ProfileKind;
    profileId: string;
    tier: VerificationTier;
  }): Promise<IdentityVerificationRecordRecord>;
  findLatestByProfile(
    profileKind: ProfileKind,
    profileId: string,
  ): Promise<IdentityVerificationRecordRecord | null>;
  /**
   * `reviewerUserId` is `string | null` — null for Sprint 9's provider-driven decision path (no
   * human reviewer), a string for Sprint 3's existing audited manual/mock path. The DB column was
   * already nullable; only this method's input type is widened, and every existing call site
   * already passes a string, so this is a backward-compatible loosening, not a behavior change.
   */
  updateDecision(
    id: string,
    input: { status: "verified" | "rejected"; reviewerUserId: string | null; reason: string | null },
  ): Promise<void>;
  /** Sprint 9: attaches the KYC/KYB provider's verification id once submission succeeds. */
  attachProviderRef(id: string, providerRef: string): Promise<void>;
  /** Sprint 9: resolves an inbound provider webhook back to the record it belongs to. */
  findByProviderRef(providerRef: string): Promise<IdentityVerificationRecordRecord | null>;
  /**
   * Closed-beta remediation (DEF-UAT-020): the admin verification queue's list source — every record
   * still sitting at `status: "pending"`, across all profiles. Mirrors DrizzleAppealRepository.listOpen's
   * identical shape (a plain, unfiltered "everything still awaiting a decision" scan).
   */
  listPending(): Promise<IdentityVerificationRecordRecord[]>;
}

/**
 * Whether the owning user has verified their email (Sprint 2). BASIC tier
 * per the master spec also names "verified phone number" — this codebase
 * has no phone-verification flow yet, so BASIC is currently derived from
 * email verification alone. Flagged here rather than silently overclaiming
 * phone verification that doesn't exist.
 */
export interface EmailVerificationReader {
  isEmailVerified(userId: string): Promise<boolean>;
}

export interface ProfileOwnerReader {
  getOwnerUserId(profileKind: ProfileKind, profileId: string): Promise<string | null>;
}

export class VerificationService {
  constructor(
    private readonly records: IdentityVerificationRecordRepository,
    private readonly emailVerification: EmailVerificationReader,
    private readonly profileOwners: ProfileOwnerReader,
    private readonly audit: AuditService,
    /** Closed-beta remediation (DEF-UAT-020): gates listPendingVerificationRequests/recordManualVerificationDecision. */
    private readonly roles: AdminRoleService,
  ) {}

  /**
   * The gating interface Sprint 6 (signing) and Sprints 9–12 (payments)
   * depend on, per this sprint's text. Depends only on this architecture,
   * never on Sprint 9's real KYC/KYB provider being wired up.
   */
  async isFullyVerified(profileKind: ProfileKind, profileId: string): Promise<boolean> {
    const latest = await this.records.findLatestByProfile(profileKind, profileId);
    return latest?.tier === "full" && latest.status === "verified";
  }

  async getVerificationState(profileKind: ProfileKind, profileId: string): Promise<VerificationState> {
    const latest = await this.records.findLatestByProfile(profileKind, profileId);
    if (latest?.tier === "full") {
      if (latest.status === "verified") return "FULL_VERIFIED";
      if (latest.status === "rejected") return "FULL_REJECTED";
      return "FULL_PENDING";
    }

    const ownerUserId = await this.profileOwners.getOwnerUserId(profileKind, profileId);
    if (!ownerUserId) return "UNVERIFIED";
    const emailVerified = await this.emailVerification.isEmailVerified(ownerUserId);
    return emailVerified ? "BASIC" : "UNVERIFIED";
  }

  async submitFullVerificationRequest(
    profileKind: ProfileKind,
    profileId: string,
  ): Promise<IdentityVerificationRecordRecord> {
    const existing = await this.records.findLatestByProfile(profileKind, profileId);
    if (existing?.status === "pending") {
      throw new ConflictError("A verification request is already pending for this profile.");
    }
    const record = await this.records.insert({ profileKind, profileId, tier: "full" });
    await this.recordAudit(profileKind, profileId, "identity_verification_requested", null, null);
    return record;
  }

  /**
   * Closed-beta remediation (DEF-UAT-020): the admin verification queue's list source. Capability-
   * gated the same way RiskEventService.listRecentForAdmin/AppealService.listOpenAppeals are — a
   * `platform_owner` bypasses via AdminRoleService's own isOwnerRole short-circuit, otherwise the
   * caller must hold `decide_identity_verification` (assigned to the `compliance` internal role).
   */
  async listPendingVerificationRequests(actingUserId: string, actingRole: PlatformRole): Promise<IdentityVerificationRecordRecord[]> {
    await this.roles.requireCapability(actingUserId, actingRole, "decide_identity_verification");
    return this.records.listPending();
  }

  /**
   * The audited manual/mock decision path this sprint's text requires —
   * "Until Sprint 9 wires a real or sandbox KYC/KYB provider, FULL_PENDING/
   * FULL_VERIFIED may be reached only through an explicit, audited
   * manual/mock verification path — never silently defaulted to verified."
   *
   * Closed-beta remediation (DEF-UAT-020): now capability-gated and exposed via a real admin route —
   * this was previously built with no caller at all ("exposing it publicly requires an admin-role/
   * authorization system, which is Sprint 18's scope, not this one's" — Sprint 18's AdminRoleService
   * now exists, closing that gap).
   */
  async recordManualVerificationDecision(input: {
    actingRole: PlatformRole;
    profileKind: ProfileKind;
    profileId: string;
    decision: "verified" | "rejected";
    reviewerUserId: string;
    reason: string | null;
  }): Promise<void> {
    await this.roles.requireCapability(input.reviewerUserId, input.actingRole, "decide_identity_verification");
    const ownerUserId = await this.profileOwners.getOwnerUserId(input.profileKind, input.profileId);
    if (ownerUserId && ownerUserId === input.reviewerUserId) {
      throw new ValidationError("A profile's own owner cannot review their own verification request.");
    }

    const latest = await this.records.findLatestByProfile(input.profileKind, input.profileId);
    if (!latest || latest.status !== "pending") {
      throw new ValidationError("No pending verification request found for this profile.");
    }

    await this.records.updateDecision(latest.id, {
      status: input.decision,
      reviewerUserId: input.reviewerUserId,
      reason: input.reason,
    });
    await this.recordAudit(
      input.profileKind,
      input.profileId,
      input.decision === "verified" ? "identity_verification_approved" : "identity_verification_rejected",
      input.reviewerUserId,
      input.reason,
    );
  }

  /**
   * Sprint 9: called once the KYC/KYB provider has accepted a submission and returned its own
   * verification id, so a later webhook (which only carries that provider id) can be resolved back
   * to this profile's pending record. Does not itself change `status` — only
   * recordProviderVerificationDecision (driven by the provider's webhook) does that.
   */
  async recordProviderSubmission(profileKind: ProfileKind, profileId: string, providerRef: string): Promise<void> {
    const latest = await this.records.findLatestByProfile(profileKind, profileId);
    if (!latest || latest.status !== "pending") {
      throw new ValidationError("No pending verification request found for this profile.");
    }
    await this.records.attachProviderRef(latest.id, providerRef);
    await this.recordAudit(profileKind, profileId, "identity_verification_provider_submitted", null, null, "kyc_provider");
  }

  /**
   * Sprint 9: the provider-driven counterpart to recordManualVerificationDecision — reached only
   * through KycWebhookService after independent signature verification and replay/duplicate-event
   * protection, never directly from a client request. Requiring `latest.status === "pending"`
   * (same guard as the manual path) makes a duplicate/replayed decision for an already-decided
   * record a no-op error rather than silently reapplying, and keeps a profile gated
   * (isFullyVerified false) for the entire time it sits at PENDING or REJECTED — there is no path
   * from REJECTED back to VERIFIED without a brand-new submitFullVerificationRequest.
   */
  async recordProviderVerificationDecision(input: {
    providerRef: string;
    decision: "verified" | "rejected";
    reason: string | null;
  }): Promise<void> {
    const latest = await this.records.findByProviderRef(input.providerRef);
    if (!latest || latest.status !== "pending") {
      throw new ValidationError("No pending verification request found for this provider reference.");
    }

    await this.records.updateDecision(latest.id, {
      status: input.decision,
      reviewerUserId: null,
      reason: input.reason,
    });
    await this.recordAudit(
      latest.profileKind,
      latest.profileId,
      input.decision === "verified" ? "identity_verification_approved" : "identity_verification_rejected",
      null,
      input.reason,
      "kyc_provider",
    );
  }

  private async recordAudit(
    profileKind: ProfileKind,
    profileId: string,
    action: string,
    actorUserId: string | null,
    reason: string | null,
    actorRoleOverride?: string,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      actorRole: actorRoleOverride ?? (actorUserId ? "reviewer" : "personal_user"),
      profileKind,
      profileId,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
