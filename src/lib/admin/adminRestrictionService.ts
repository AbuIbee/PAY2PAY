import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import type { AdminRoleService } from "./adminRoleService";
import type { AdminCapability } from "./adminCapabilities";

export type AdminRestrictionType = "payment_activity" | "new_agreement_creation" | "payout";

export interface AdminRestrictionRecord {
  id: string;
  restrictionType: AdminRestrictionType;
  targetResourceType: string;
  targetResourceId: string;
  reason: string;
  caseReference: string | null;
  placedByUserId: string;
  placedAt: Date;
  liftedByUserId: string | null;
  liftedAt: Date | null;
}

/** Real implementation: DrizzleAdminRestrictionRepository. Append-only — `lift` only ever sets the lift fields on an existing row. */
export interface AdminRestrictionRepository {
  insert(input: {
    restrictionType: AdminRestrictionType;
    targetResourceType: string;
    targetResourceId: string;
    reason: string;
    caseReference: string | null;
    placedByUserId: string;
  }): Promise<AdminRestrictionRecord>;
  findById(id: string): Promise<AdminRestrictionRecord | null>;
  findActive(targetResourceType: string, targetResourceId: string, restrictionType: AdminRestrictionType): Promise<AdminRestrictionRecord | null>;
  listForTarget(targetResourceType: string, targetResourceId: string): Promise<AdminRestrictionRecord[]>;
  markLifted(id: string, liftedByUserId: string, liftedAt: Date): Promise<AdminRestrictionRecord>;
}

export interface AdminRestrictionServiceDeps {
  restrictions: AdminRestrictionRepository;
  roles: AdminRoleService;
  audit: AuditService;
}

const RESTRICTION_CAPABILITY: Record<AdminRestrictionType, AdminCapability> = {
  payment_activity: "restrict_payment_activity",
  new_agreement_creation: "restrict_new_agreements",
  payout: "restrict_payout",
};

/**
 * Sprint 18's general-purpose, admin-initiated restriction mechanism — "restrict payment activity,"
 * "restrict new agreements," "restrict payouts where permitted" (this sprint's own instruction,
 * verbatim). Deliberately narrower in scope than it might first appear, to avoid three separate kinds
 * of duplication already present elsewhere in this codebase:
 *
 * - **Not account suspension.** Sprint 6A's `AdminService.suspendUser`/`reactivateUser` already
 *   fully suspend a user account (blocking login entirely) — reused unchanged, never duplicated here.
 * - **Not Sprint 18A's relationship-scoped restriction.** `RelationshipService.restrict` marks one
 *   specific cooperative relationship `restricted`; this class knows nothing about relationships at
 *   all and never touches that table. A relationship's own participants may still be independently
 *   restricted here (e.g. `restrict_new_agreements` on the underlying `user_account`), but this class
 *   has no relationship-specific behavior and is not a replacement for Sprint 18A's own mechanism —
 *   per this sprint's own instruction, "do not duplicate or replace Sprint 18A relationship
 *   restriction behavior unless the authoritative Sprint 18 specification explicitly requires
 *   integration," which it does not.
 * - **Not Sprint 16's dispute-scoped restriction.** `agreement_dispute.status = 'restricted'` is a
 *   restriction meaningful only within one specific dispute's own lifecycle (and is lifted by
 *   `AgreementDisputeService.liftRestriction`, not this class). This class's restrictions are
 *   admin-initiated independent of any dispute ever existing.
 *
 * `isRestricted` is exposed for a future integration into live payment-scheduling/agreement-creation
 * code paths (Sprint 5/9/11/12) — **deliberately not wired into any of those services in this pass**,
 * mirroring Sprint 16's own identical, previously-accepted documented gap ("scheduled payments
 * continue unless... processor/admin restriction applies" is not yet enforced by any payment-scheduling
 * code) for the same reason: wiring it touches several already-shipped, already-tested prior-sprint
 * files, a cross-cutting effort out of this sprint's own bounded scope, not silently assumed complete.
 */
export class AdminRestrictionService {
  constructor(private readonly deps: AdminRestrictionServiceDeps) {}

  async restrict(input: {
    restrictionType: AdminRestrictionType;
    targetResourceType: string;
    targetResourceId: string;
    reason: string;
    caseReference?: string | null;
    actingUserId: string;
    actingRole: PlatformRole;
  }): Promise<AdminRestrictionRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, RESTRICTION_CAPABILITY[input.restrictionType]);
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required to place a restriction.");
    }
    const existing = await this.deps.restrictions.findActive(input.targetResourceType, input.targetResourceId, input.restrictionType);
    if (existing) {
      throw new ValidationError(`An active "${input.restrictionType}" restriction already exists for this target — lift it first.`);
    }
    const record = await this.deps.restrictions.insert({
      restrictionType: input.restrictionType,
      targetResourceType: input.targetResourceType,
      targetResourceId: input.targetResourceId,
      reason: input.reason,
      caseReference: input.caseReference ?? null,
      placedByUserId: input.actingUserId,
    });
    await this.recordAudit(record, "admin_restriction_placed", input.actingUserId, input.reason);
    return record;
  }

  async lift(input: { restrictionId: string; actingUserId: string; actingRole: PlatformRole; reason: string | null }): Promise<AdminRestrictionRecord> {
    const restriction = await this.deps.restrictions.findById(input.restrictionId);
    if (!restriction) throw new ValidationError("Restriction not found.");
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, RESTRICTION_CAPABILITY[restriction.restrictionType]);
    return this.doLift(restriction, input.actingUserId, input.reason);
  }

  /**
   * The one exception to `lift`'s own restriction-type capability check — called only by
   * `AppealService.decideAppeal`, which has already independently verified the caller holds
   * `manage_appeal` *and* is this specific appeal's assigned reviewer (itself guaranteed distinct
   * from whoever placed the original restriction — see `appeal.ts`'s own CHECK constraint). Requiring
   * the reviewer to *also* separately hold `restrict_payment_activity`/`restrict_new_agreements`/
   * `restrict_payout` would defeat the appeals process's own purpose: an independent reviewer
   * overturning a decision must be able to reverse its concrete effect even when they would never have
   * had authority to place that kind of restriction themselves in the first place.
   */
  async liftAsAppealOutcome(input: { restrictionId: string; actingUserId: string; reason: string | null }): Promise<AdminRestrictionRecord> {
    const restriction = await this.deps.restrictions.findById(input.restrictionId);
    if (!restriction) throw new ValidationError("Restriction not found.");
    return this.doLift(restriction, input.actingUserId, input.reason);
  }

  private async doLift(restriction: AdminRestrictionRecord, actingUserId: string, reason: string | null): Promise<AdminRestrictionRecord> {
    if (restriction.liftedAt) throw new ValidationError("This restriction has already been lifted.");
    const updated = await this.deps.restrictions.markLifted(restriction.id, actingUserId, new Date());
    await this.recordAudit(updated, "admin_restriction_lifted", actingUserId, reason);
    return updated;
  }

  /** Read-only — the one seam a future payment-scheduling/agreement-creation integration would call; never itself gated, since it answers a yes/no question with no sensitive detail. */
  async isRestricted(targetResourceType: string, targetResourceId: string, restrictionType: AdminRestrictionType): Promise<boolean> {
    return (await this.deps.restrictions.findActive(targetResourceType, targetResourceId, restrictionType)) !== null;
  }

  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<AdminRestrictionRecord[]> {
    return this.deps.restrictions.listForTarget(targetResourceType, targetResourceId);
  }

  private async recordAudit(restriction: AdminRestrictionRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "platform_admin",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { restrictionType: restriction.restrictionType, targetResourceType: restriction.targetResourceType, targetResourceId: restriction.targetResourceId },
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: restriction.targetResourceType,
      targetResourceId: restriction.targetResourceId,
    });
  }
}
