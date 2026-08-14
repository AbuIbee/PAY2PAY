import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import { isAdminRole } from "./capabilities";
import type { AdminRoleService } from "./adminRoleService";

export type RetentionHoldType = "retention" | "dispute" | "fraud_review" | "litigation" | "administrative_override";

export interface RetentionHoldRecord {
  id: string;
  targetResourceType: string;
  targetResourceId: string;
  holdType: RetentionHoldType;
  reason: string;
  placedByUserId: string;
  placedAt: Date;
  releasedByUserId: string | null;
  releasedAt: Date | null;
}

/** Real implementation: DrizzleRetentionHoldRepository. Append-only — `release` only ever sets the release fields on an existing row. */
export interface RetentionHoldRepository {
  insert(input: { targetResourceType: string; targetResourceId: string; holdType: RetentionHoldType; reason: string; placedByUserId: string }): Promise<RetentionHoldRecord>;
  findById(id: string): Promise<RetentionHoldRecord | null>;
  listForTarget(targetResourceType: string, targetResourceId: string): Promise<RetentionHoldRecord[]>;
  listActive(): Promise<RetentionHoldRecord[]>;
  markReleased(id: string, releasedByUserId: string, releasedAt: Date): Promise<RetentionHoldRecord>;
}

export interface RetentionHoldServiceDeps {
  holds: RetentionHoldRepository;
  roles: AdminRoleService;
  audit: AuditService;
}

/**
 * Sprint 18 §"Retention and legal holds": "A hold of any type blocks scheduled deletion/minimization
 * of the affected records until every applicable hold on those records is explicitly released." This
 * class owns exactly two things: placing/releasing holds, and `hasActiveHold` — the query a future
 * deletion/minimization job must consult before purging anything.
 *
 * **No scheduled deletion/minimization job exists anywhere in this codebase yet** (master spec §28's
 * "seven-year retention" policy has never had an active purge pipeline built for it in any prior
 * sprint) — this class makes the hold mechanism itself fully correct and ready, but `hasActiveHold`
 * has no real caller enforcing it end-to-end yet. Documented explicitly as a known limitation, not
 * silently assumed complete; the natural owner is whichever future sprint builds the actual deletion
 * job (Sprint 20's "closed beta readiness... retention verification" per `docs/SPRINT_CONTROL.md`'s
 * own dependency graph, or a dedicated data-lifecycle sprint).
 */
export class RetentionHoldService {
  constructor(private readonly deps: RetentionHoldServiceDeps) {}

  async placeHold(input: {
    targetResourceType: string;
    targetResourceId: string;
    holdType: RetentionHoldType;
    reason: string;
    actingUserId: string;
    actingRole: PlatformRole;
  }): Promise<RetentionHoldRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "place_retention_hold");
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required to place a retention hold.");
    }
    const record = await this.deps.holds.insert({
      targetResourceType: input.targetResourceType,
      targetResourceId: input.targetResourceId,
      holdType: input.holdType,
      reason: input.reason,
      placedByUserId: input.actingUserId,
    });
    await this.recordAudit(record, "retention_hold_placed", input.actingUserId, input.reason);
    return record;
  }

  async releaseHold(input: { holdId: string; actingUserId: string; actingRole: PlatformRole; reason: string | null }): Promise<RetentionHoldRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "release_retention_hold");
    const hold = await this.deps.holds.findById(input.holdId);
    if (!hold) throw new ValidationError("Retention hold not found.");
    if (hold.releasedAt) throw new ValidationError("This retention hold has already been released.");
    const updated = await this.deps.holds.markReleased(hold.id, input.actingUserId, new Date());
    await this.recordAudit(updated, "retention_hold_released", input.actingUserId, input.reason);
    return updated;
  }

  /** Read-only, unauthenticated-safe — a future deletion job (or any internal check) must be able to call this without itself needing admin capabilities; it answers a yes/no question, never reveals hold reasons or who placed them. */
  async hasActiveHold(targetResourceType: string, targetResourceId: string): Promise<boolean> {
    const holds = await this.deps.holds.listForTarget(targetResourceType, targetResourceId);
    return holds.some((h) => h.releasedAt === null);
  }

  async listHoldsForTarget(input: { targetResourceType: string; targetResourceId: string; actingUserId: string; actingRole: PlatformRole }): Promise<RetentionHoldRecord[]> {
    if (!isAdminRole(input.actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    return this.deps.holds.listForTarget(input.targetResourceType, input.targetResourceId);
  }

  async listActiveHolds(actingUserId: string, actingRole: PlatformRole): Promise<RetentionHoldRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "place_retention_hold");
    return this.deps.holds.listActive();
  }

  private async recordAudit(hold: RetentionHoldRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
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
      newValue: { holdType: hold.holdType, targetResourceType: hold.targetResourceType, targetResourceId: hold.targetResourceId },
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: hold.targetResourceType,
      targetResourceId: hold.targetResourceId,
    });
  }
}

