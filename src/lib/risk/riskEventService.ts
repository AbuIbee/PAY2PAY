import "server-only";
import type { AdminRoleService } from "@/lib/admin/adminRoleService";
import type { PlatformRole } from "@/lib/auth/authService";
import { ValidationError } from "@/lib/errors";

export type RiskSignalType =
  | "repeated_authentication_failure"
  | "repeated_payment_failure"
  | "frequent_bank_connection_change"
  | "high_value_action_new_account"
  | "invitation_velocity"
  | "unusual_admin_activity";

export type RiskSignalSeverity = "info" | "low" | "medium" | "high";

/** "allow" is implicit — no row is ever written for it. See riskSignal.ts's own doc comment. */
export type RiskSignalOutcome = "flagged" | "challenge_recommended" | "manual_review_recommended";

export type RiskSignalReviewState = "open" | "reviewed" | "dismissed";

export interface RiskEventRecord {
  id: string;
  userId: string;
  signalType: RiskSignalType;
  severity: RiskSignalSeverity;
  outcome: RiskSignalOutcome;
  relatedResourceType: string | null;
  relatedResourceId: string | null;
  /** Small, already-derived counters only (e.g. {count, windowMinutes}) — never a raw IP/device fingerprint or free-text user description. */
  detail: Record<string, unknown> | null;
  createdAt: Date;
  reviewState: RiskSignalReviewState;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
}

/** Real implementation: DrizzleRiskEventRepository. Append-only except for the review-decision fields — see RiskEventService's own doc comment. */
export interface RiskEventRepository {
  insert(input: {
    userId: string;
    signalType: RiskSignalType;
    severity: RiskSignalSeverity;
    outcome: RiskSignalOutcome;
    relatedResourceType: string | null;
    relatedResourceId: string | null;
    detail: Record<string, unknown> | null;
  }): Promise<RiskEventRecord>;
  findById(id: string): Promise<RiskEventRecord | null>;
  listForUser(userId: string): Promise<RiskEventRecord[]>;
  /** Admin dashboard's default view — most recent first, optionally scoped to open review items only. */
  listRecent(input: { openOnly: boolean; limit: number }): Promise<RiskEventRecord[]>;
  markReviewed(id: string, reviewedByUserId: string, reviewState: "reviewed" | "dismissed"): Promise<RiskEventRecord>;
}

/**
 * SPRINT_19_FraudRisk_SecurityHardening §12/§13: records fraud/risk signals without automatically
 * accusing a user of fraud. This is a signal ledger, not an enforcement mechanism — `recordSignal`
 * never blocks, rejects, restricts, or otherwise affects the action that triggered it; it only makes
 * the pattern visible to admins (§13), mirroring the existing `payment_flagged_for_review` precedent
 * (PRSprint 33), which also only ever flags. Callers decide their own severity/outcome from local
 * context (e.g. "3 failed payments in 15 minutes" → severity "medium", outcome "flagged") — this
 * service does not invent a universal scoring policy across unrelated signal types, per this sprint's
 * own "do not invent financial policy as fact" instruction.
 *
 * Deliberately fire-and-forget-safe for callers: `recordSignal` can throw (e.g. on invalid input),
 * so every integration call site wraps it exactly like this codebase's existing "never fail the
 * primary action on a secondary side-effect's failure" pattern (`PaymentWebhookService.
 * checkCompletion`/`notifyPaymentStatus`) — recording a risk signal must never be the reason a
 * legitimate action fails.
 */
export class RiskEventService {
  constructor(private readonly deps: { riskEvents: RiskEventRepository; roles: AdminRoleService }) {}

  async recordSignal(input: {
    userId: string;
    signalType: RiskSignalType;
    severity: RiskSignalSeverity;
    outcome: RiskSignalOutcome;
    relatedResourceType?: string | null;
    relatedResourceId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<RiskEventRecord> {
    if (!input.userId.trim()) {
      throw new ValidationError("A userId is required to record a risk signal.");
    }
    return this.deps.riskEvents.insert({
      userId: input.userId,
      signalType: input.signalType,
      severity: input.severity,
      outcome: input.outcome,
      relatedResourceType: input.relatedResourceType ?? null,
      relatedResourceId: input.relatedResourceId ?? null,
      detail: input.detail ?? null,
    });
  }

  /**
   * A user's own risk-signal history is intentionally NOT exposed to that user — unlike consent
   * records, showing a user "you were flagged" invites gaming the detection. Admin-only surface,
   * gated by the `review_fraud_alert` capability `docs/SPRINT_CONTROL.md`'s Sprint 18 notes
   * explicitly declared for this exact purpose ("so Sprint 19 has an existing capability to gate
   * against rather than inventing a competing one") — checked here (not just at the route layer),
   * matching `AdminCaseReviewService`'s identical `roles.requireCapability` pattern and this
   * codebase's two-independent-layers authorization principle (docs/SECURITY_MODEL.md §11).
   */
  async listRecentForAdmin(actingUserId: string, actingRole: PlatformRole, input: { openOnly: boolean; limit: number }): Promise<RiskEventRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "review_fraud_alert");
    const limit = Math.min(Math.max(input.limit, 1), 200);
    return this.deps.riskEvents.listRecent({ openOnly: input.openOnly, limit });
  }

  async listForUserAdmin(actingUserId: string, actingRole: PlatformRole, userId: string): Promise<RiskEventRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "review_fraud_alert");
    return this.deps.riskEvents.listForUser(userId);
  }

  async markReviewed(actingUserId: string, actingRole: PlatformRole, id: string, reviewedByUserId: string, decision: "reviewed" | "dismissed"): Promise<RiskEventRecord> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "review_fraud_alert");
    const existing = await this.deps.riskEvents.findById(id);
    if (!existing) throw new ValidationError("Risk event not found.");
    return this.deps.riskEvents.markReviewed(id, reviewedByUserId, decision);
  }
}
