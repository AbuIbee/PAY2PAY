import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { LedgerAccountType, LedgerPostingDirection, LedgerJournalEntryRecord } from "@/lib/ledger/ledgerService";
import type { AdminRoleService } from "./adminRoleService";
import type { AdminRestrictionService } from "./adminRestrictionService";

export type AppealStatus = "submitted" | "under_review" | "decided";
export type AppealDecision = "upheld" | "overturned" | "partially_overturned";

export interface AppealRecord {
  id: string;
  appealingUserId: string;
  targetResourceType: string;
  targetResourceId: string;
  originalDecisionSummary: string;
  originalDecisionByUserId: string | null;
  evidenceDescription: string | null;
  status: AppealStatus;
  reviewerUserId: string | null;
  decision: AppealDecision | null;
  rationale: string | null;
  decidedAt: Date | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleAppealRepository. */
export interface AppealRepository {
  insert(input: {
    appealingUserId: string;
    targetResourceType: string;
    targetResourceId: string;
    originalDecisionSummary: string;
    originalDecisionByUserId: string | null;
    evidenceDescription: string | null;
  }): Promise<AppealRecord>;
  findById(id: string): Promise<AppealRecord | null>;
  listForUser(appealingUserId: string): Promise<AppealRecord[]>;
  listOpen(): Promise<AppealRecord[]>;
  assignReviewer(id: string, reviewerUserId: string): Promise<AppealRecord>;
  recordDecision(id: string, input: { decision: AppealDecision; rationale: string; decidedAt: Date }): Promise<AppealRecord>;
  markNotified(id: string, notifiedAt: Date): Promise<AppealRecord>;
}

/** Narrow interface onto Sprint 10's LedgerAdminService.postAdjustment — reused entirely unchanged (Owner-gated internally by that service itself; this class never re-checks or weakens that gate). */
export interface LedgerAdjustmentPoster {
  postAdjustment(
    actingRole: PlatformRole,
    actingUserId: string,
    input: {
      paymentAttemptId: string;
      agreementId: string;
      currency: string;
      targetAccountType: Exclude<LedgerAccountType, "admin_adjustment_suspense">;
      direction: LedgerPostingDirection;
      amountMinorUnits: number;
      reason: string;
    },
  ): Promise<LedgerJournalEntryRecord>;
}

export interface AppealServiceDeps {
  appeals: AppealRepository;
  roles: AdminRoleService;
  restrictions: AdminRestrictionService;
  ledger: LedgerAdjustmentPoster;
  notifications: NotificationService;
  audit: AuditService;
}

/**
 * Sprint 18 §30 Appeals. "The platform must not adjudicate legal liability" is enforced by
 * construction the same way Sprint 16's dispute tables already do: `decideAppeal`'s `rationale` is a
 * free-text record of what happened, never a structured "who was at fault" field anywhere on this
 * table.
 *
 * "Prevent the original decision-maker from being the sole appeal reviewer" is enforced at two
 * layers: the DB `CHECK` constraint (`appeal.ts`'s own doc comment) and `assignReviewer`'s own
 * application-level check below — the DB layer is the actual guarantee (cannot be bypassed by any
 * future caller), the application-level check exists to fail with a clear `ValidationError` message
 * before ever reaching the DB constraint violation.
 *
 * "Keep restrictions in place during review unless an authorized reviewer lifts them" is enforced by
 * construction: nothing on the `appeal` table itself can lift a restriction — only `decideAppeal`'s
 * own explicit, optional `liftRestrictionId` call into `AdminRestrictionService.liftAsAppealOutcome`
 * can, and only for an `overturned`/`partially_overturned` decision. An `upheld` decision never
 * touches the restriction at all. `liftAsAppealOutcome` deliberately skips `lift`'s own
 * restriction-type capability check — see that method's own doc comment for why: this class has
 * already independently verified the caller holds `manage_appeal` and is this specific appeal's
 * assigned (and structurally distinct-from-the-original-decision-maker) reviewer, which is the
 * correct and sufficient authorization for reversing this specific restriction's effect.
 *
 * `decideAppeal`'s optional `ledgerAdjustment` reuses Sprint 10's existing `LedgerAdminService
 * .postAdjustment` escape hatch verbatim (same "traceable compensating mechanism" precedent Sprint 16
 * already established) — no new financial-adjustment logic is invented here, and that service's own
 * Owner-only gate is never bypassed or re-implemented.
 */
export class AppealService {
  constructor(private readonly deps: AppealServiceDeps) {}

  /** User-initiated — any authenticated user may appeal a decision made against their own account; not admin-gated on submission. */
  async submitAppeal(input: {
    appealingUserId: string;
    targetResourceType: string;
    targetResourceId: string;
    originalDecisionSummary: string;
    originalDecisionByUserId: string | null;
    evidenceDescription: string | null;
  }): Promise<AppealRecord> {
    if (!input.originalDecisionSummary.trim()) {
      throw new ValidationError("A summary of the original decision is required to submit an appeal.");
    }
    const record = await this.deps.appeals.insert(input);
    await this.recordAudit(record, "appeal_submitted", input.appealingUserId, null);
    return record;
  }

  async assignReviewer(input: { appealId: string; reviewerUserId: string; actingUserId: string; actingRole: PlatformRole }): Promise<AppealRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "manage_appeal");
    const appeal = await this.requireAppeal(input.appealId);
    if (appeal.status === "decided") {
      throw new ValidationError("This appeal has already been decided.");
    }
    if (appeal.originalDecisionByUserId && appeal.originalDecisionByUserId === input.reviewerUserId) {
      throw new ForbiddenError("The original decision-maker may not be the sole appeal reviewer.");
    }
    const updated = await this.deps.appeals.assignReviewer(appeal.id, input.reviewerUserId);
    await this.recordAudit(updated, "appeal_reviewer_assigned", input.actingUserId, null);
    return updated;
  }

  async decideAppeal(input: {
    appealId: string;
    decision: AppealDecision;
    rationale: string;
    liftRestrictionId?: string;
    ledgerAdjustment?: {
      paymentAttemptId: string;
      agreementId: string;
      currency: string;
      targetAccountType: Exclude<LedgerAccountType, "admin_adjustment_suspense">;
      direction: LedgerPostingDirection;
      amountMinorUnits: number;
      reason: string;
    };
    actingUserId: string;
    actingRole: PlatformRole;
  }): Promise<AppealRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "manage_appeal");
    const appeal = await this.requireAppeal(input.appealId);
    if (appeal.status === "decided") {
      throw new ValidationError("This appeal has already been decided.");
    }
    if (!appeal.reviewerUserId) {
      throw new ValidationError("An appeal must have an assigned reviewer before it can be decided.");
    }
    if (appeal.reviewerUserId !== input.actingUserId) {
      throw new ForbiddenError("Only this appeal's assigned reviewer may decide it.");
    }
    if (!input.rationale.trim()) {
      throw new ValidationError("A rationale is required to decide an appeal.");
    }

    const updated = await this.deps.appeals.recordDecision(appeal.id, { decision: input.decision, rationale: input.rationale, decidedAt: new Date() });
    await this.recordAudit(updated, "appeal_decided", input.actingUserId, input.rationale);

    if (input.decision !== "upheld" && input.liftRestrictionId) {
      await this.deps.restrictions.liftAsAppealOutcome({
        restrictionId: input.liftRestrictionId,
        actingUserId: input.actingUserId,
        reason: `Appeal ${appeal.id} ${input.decision}: ${input.rationale}`,
      });
    }

    if (input.decision !== "upheld" && input.ledgerAdjustment) {
      await this.deps.ledger.postAdjustment(input.actingRole, input.actingUserId, input.ledgerAdjustment);
    }

    await this.deps.notifications.notify({
      recipientUserId: appeal.appealingUserId,
      notificationType: "appeal_decided",
      relatedAgreementId: input.ledgerAdjustment?.agreementId ?? null,
      payload: { appealId: appeal.id, decision: input.decision },
      dedupeKey: `appeal_decided:${appeal.id}`,
    });
    await this.deps.appeals.markNotified(appeal.id, new Date());

    return updated;
  }

  async getAppeal(appealId: string): Promise<AppealRecord> {
    return this.requireAppeal(appealId);
  }

  async listAppealsForUser(appealingUserId: string): Promise<AppealRecord[]> {
    return this.deps.appeals.listForUser(appealingUserId);
  }

  async listOpenAppeals(actingUserId: string, actingRole: PlatformRole): Promise<AppealRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "manage_appeal");
    return this.deps.appeals.listOpen();
  }

  private async requireAppeal(id: string): Promise<AppealRecord> {
    const record = await this.deps.appeals.findById(id);
    if (!record) throw new ValidationError("Appeal not found.");
    return record;
  }

  private async recordAudit(appeal: AppealRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
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
      newValue: { status: appeal.status, decision: appeal.decision },
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: appeal.id,
      targetResourceType: appeal.targetResourceType,
      targetResourceId: appeal.targetResourceId,
    });
  }
}
