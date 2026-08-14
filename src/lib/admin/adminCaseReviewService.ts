import "server-only";
import type { PlatformRole } from "@/lib/auth/authService";
import type { AuditEventRecord } from "@/lib/audit/auditService";
import type { ProfileKind, VerificationState } from "@/lib/profiles/verificationService";
import type { AgreementDisputeRecord } from "@/lib/disputes/agreementDisputeService";
import type { PaymentDisputeRecord } from "@/lib/disputes/paymentDisputeService";
import type { AdminRoleService } from "./adminRoleService";

/** Narrow reader onto Sprint 3's VerificationService — this class only ever needs the read, never the write/decision path (those remain Sprint 3's own). */
export interface VerificationStatusReader {
  getVerificationState(profileKind: ProfileKind, profileId: string): Promise<VerificationState>;
}

/** Narrow reader directly onto Sprint 16's dispute repositories (not the party-gated `AgreementDisputeService`/`PaymentDisputeService` themselves — those require the caller be a resolvable agreement party, which an admin reviewer is not). Real implementation reuses the existing `AgreementDisputeRepository`/`PaymentDisputeRepository` interfaces unchanged — no new storage, no new dispute logic, just an admin-authorized read path onto the same rows. */
export interface AdminDisputeReader {
  findAgreementDisputeById(id: string): Promise<AgreementDisputeRecord | null>;
  findPaymentDisputeById(id: string): Promise<PaymentDisputeRecord | null>;
}

/** Real implementation: DrizzleAdminAuditReader — a new, read-only query onto the existing `audit_event` table (Sprint 0), mirroring Sprint 6A's own `AdminOverviewReader` precedent of a dedicated read-only reader class rather than expanding `AuditEventRepository`'s own minimal write-path interface. */
export interface AdminAuditReader {
  listForTarget(targetResourceType: string, targetResourceId: string): Promise<AuditEventRecord[]>;
}

export interface AdminCaseReviewServiceDeps {
  roles: AdminRoleService;
  verification: VerificationStatusReader;
  disputes: AdminDisputeReader;
  auditReader: AdminAuditReader;
}

/**
 * Sprint 18 §29's read-only oversight surfaces: "review identity-verification status," "review
 * disputes," "review audit logs" (and, by the same shared method, "review payment failures" — every
 * payment failure is already an audited event, see `adminCapabilities.ts`'s own doc comment for why no
 * separate dedicated read path was built for it). Every method here is a pure read reusing an existing
 * prior-sprint data source unchanged — this class introduces no new domain logic, only admin-authorized
 * access to data that already exists.
 *
 * **"Review fraud alerts" has no backing method here** — no `fraud_alert` (or equivalent) table exists
 * anywhere in this codebase yet; that is Sprint 19's own future scope (see `adminCapabilities.ts`).
 *
 * Read-by-ID only, not a full cross-platform listing dashboard (e.g. "every open dispute right now") —
 * an admin reviewing a specific case/ticket already knows which dispute/profile they're investigating.
 * A full dashboard view is a reasonable future enhancement, not built in this pass (see this sprint's
 * own completion report's Known Limitations).
 */
export class AdminCaseReviewService {
  constructor(private readonly deps: AdminCaseReviewServiceDeps) {}

  async getVerificationStatus(input: { profileKind: ProfileKind; profileId: string; actingUserId: string; actingRole: PlatformRole }): Promise<VerificationState> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "review_verification_status");
    return this.deps.verification.getVerificationState(input.profileKind, input.profileId);
  }

  async getAgreementDispute(input: { disputeId: string; actingUserId: string; actingRole: PlatformRole }): Promise<AgreementDisputeRecord | null> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "review_dispute");
    return this.deps.disputes.findAgreementDisputeById(input.disputeId);
  }

  async getPaymentDispute(input: { disputeId: string; actingUserId: string; actingRole: PlatformRole }): Promise<PaymentDisputeRecord | null> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "review_dispute");
    return this.deps.disputes.findPaymentDisputeById(input.disputeId);
  }

  /** Also satisfies "review payment failures" when the target is a payment-adjacent resource — see this class's own doc comment. */
  async listAuditEventsForTarget(input: { targetResourceType: string; targetResourceId: string; actingUserId: string; actingRole: PlatformRole }): Promise<AuditEventRecord[]> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "review_audit_logs");
    return this.deps.auditReader.listForTarget(input.targetResourceType, input.targetResourceId);
  }
}
