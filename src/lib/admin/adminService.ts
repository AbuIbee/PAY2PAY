import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { AccountClassification, PlatformRole, SessionRepository, UserAccountRepository } from "@/lib/auth/authService";
import type { MfaService } from "@/lib/auth/mfaService";
import { ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { isAdminRole, isOwnerRole } from "./capabilities";

export interface AdminOverviewData {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  testAccounts: number;
  personalProfileCount: number;
  businessProfileCount: number;
  agreementCountsByStatus: Record<string, number>;
  signatureEventCount: number;
  agreementPdfCount: number;
  recentAuditEvents: AdminAuditEventSummary[];
  recentAdminActions: AdminAuditEventSummary[];
}

export interface AdminAuditEventSummary {
  id: number;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  occurredAt: string;
  targetResourceType: string | null;
  targetResourceId: string | null;
  reason: string | null;
}

/** Real implementation: DrizzleAdminOverviewReader. Read-only aggregate queries only. */
export interface AdminOverviewReader {
  getOverview(): Promise<AdminOverviewData>;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  status: string;
  platformRole: PlatformRole;
  accountClassification: AccountClassification;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AdminUserDetail extends AdminUserSummary {
  emailVerifiedAt: Date | null;
  personalProfileId: string | null;
  businessProfiles: { id: string; displayName: string; status: string }[];
  agreements: { id: string; status: string; relationshipShape: string }[];
}

/** Real implementation: DrizzleAdminUserDirectoryReader. Read-only queries only — never mutates. */
export interface AdminUserDirectoryReader {
  search(query: { email?: string; userId?: string }): Promise<AdminUserSummary[]>;
  getSummary(userId: string): Promise<AdminUserSummary | null>;
  getDetail(userId: string): Promise<AdminUserDetail | null>;
}

export interface AdminImpersonationSessionRecord {
  id: string;
  adminUserId: string;
  targetUserId: string;
  reason: string;
  startedAt: Date;
  endedAt: Date | null;
}

/** Real implementation: DrizzleAdminImpersonationSessionRepository. */
export interface AdminImpersonationSessionRepository {
  insert(input: { adminUserId: string; targetUserId: string; reason: string }): Promise<AdminImpersonationSessionRecord>;
  findById(id: string): Promise<AdminImpersonationSessionRecord | null>;
  markEnded(id: string, endedAt: Date): Promise<void>;
}

interface ActingContext {
  actingUserId: string;
  actingSessionId: string;
  actingRole: PlatformRole;
  ipAddress: string | null;
  deviceInfo: unknown;
}

export interface AdminServiceDeps {
  users: UserAccountRepository;
  sessions: SessionRepository;
  mfa: MfaService;
  audit: AuditService;
  overview: AdminOverviewReader;
  directory: AdminUserDirectoryReader;
  impersonationSessions: AdminImpersonationSessionRepository;
}

/**
 * Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md) platform
 * administration and audit control. Every method re-checks `actingRole` itself (never trusts a
 * caller to have already gated) — `actingRole` must always come from the trusted, DB-sourced value
 * on `requireSession`'s result, never from client-supplied state (the sprint's explicit "No client
 * application may determine its own trusted role").
 *
 * Deliberately has no method that can touch `agreement`, `agreement_version`, `agreement_party`,
 * `installment_schedule_item`, `signature_event`, or `agreement_pdf` — this class does not import
 * AgreementService or SignatureService at all, so there is no code path here that could weaken
 * Sprint 5/6's immutability guarantees, by construction rather than by a runtime check alone
 * (this sprint's "Neither PLATFORM_ADMIN nor PLATFORM_OWNER may silently alter... signed agreement
 * terms... immutable agreement versions... signature evidence... generated immutable PDF
 * records...").
 */
export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  async getDashboardOverview(actingRole: PlatformRole): Promise<AdminOverviewData> {
    this.requireAdmin(actingRole);
    return this.deps.overview.getOverview();
  }

  async searchUsers(actingRole: PlatformRole, query: { email?: string; userId?: string }): Promise<AdminUserSummary[]> {
    this.requireAdmin(actingRole);
    return this.deps.directory.search(query);
  }

  async getUserDetail(ctx: ActingContext, targetUserId: string): Promise<AdminUserDetail> {
    this.requireAdmin(ctx.actingRole);
    const detail = await this.deps.directory.getDetail(targetUserId);
    if (!detail) throw new ValidationError("User not found.");
    await this.recordAdminAudit(ctx, "admin_user_viewed", targetUserId, null, null);
    return detail;
  }

  async suspendUser(ctx: ActingContext, targetUserId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    if (target.status === "suspended") {
      throw new ValidationError("This account is already suspended.");
    }
    await this.deps.users.updateStatus(targetUserId, "suspended");
    // Suspension must take effect immediately, not just at the target's next login — revoking
    // every existing session closes that gap (AuthService.validateSession also independently
    // rejects a non-active status as defense in depth, but this is the primary mechanism).
    await this.deps.sessions.revokeAllForUser(targetUserId);
    await this.recordAdminAudit(ctx, "admin_user_suspended", targetUserId, reason, { status: "suspended" });
  }

  async reactivateUser(ctx: ActingContext, targetUserId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    if (target.status === "active") {
      throw new ValidationError("This account is already active.");
    }
    await this.deps.users.updateStatus(targetUserId, "active");
    await this.recordAdminAudit(ctx, "admin_user_reactivated", targetUserId, reason, { status: "active" });
  }

  async revokeUserSessions(ctx: ActingContext, targetUserId: string, reason: string | null): Promise<void> {
    await this.authorizeMutableTarget(ctx, targetUserId);
    await this.deps.sessions.revokeAllForUser(targetUserId);
    await this.recordAdminAudit(ctx, "admin_sessions_revoked", targetUserId, reason, null);
  }

  /**
   * Owner-only. Deliberately supports only member<->platform_admin — this endpoint can never
   * assign or remove platform_owner (authorizeMutableTarget already blocks any target whose
   * *current* role is platform_owner, and the input type only accepts "member"/"platform_admin"
   * as the new role), so there is no "last owner" scenario to guard against: ownership can never
   * change through this feature at all, matching the sprint's Role Administration section
   * ("Promote eligible Member -> Platform Admin. Demote Platform Admin -> Member.") literally.
   */
  async changeUserRole(
    ctx: ActingContext,
    targetUserId: string,
    newRole: Extract<PlatformRole, "member" | "platform_admin">,
    reason: string,
  ): Promise<void> {
    if (!isOwnerRole(ctx.actingRole)) {
      throw new ForbiddenError("Platform Owner access is required to change a platform role.");
    }
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: ctx.actingUserId,
      sessionId: ctx.actingSessionId,
      action: "admin_role_change",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to change a platform role.");
    }
    if (target.platformRole === newRole) {
      throw new ValidationError(`This account already has the "${newRole}" role.`);
    }
    await this.deps.users.updatePlatformRole(targetUserId, newRole);
    await this.recordAdminAudit(ctx, "admin_role_changed", targetUserId, reason, {
      previousRole: target.platformRole,
      newRole,
    });
  }

  async changeAccountClassification(
    ctx: ActingContext,
    targetUserId: string,
    classification: AccountClassification,
  ): Promise<void> {
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    if (target.accountClassification === classification) {
      throw new ValidationError(`This account is already classified as "${classification}".`);
    }
    await this.deps.users.updateAccountClassification(targetUserId, classification);
    await this.recordAdminAudit(ctx, "admin_classification_changed", targetUserId, null, {
      previousClassification: target.accountClassification,
      newClassification: classification,
    });
  }

  /**
   * "View As User" (Sprint 6A §8) — deliberately read-only: returns an aggregated snapshot, never
   * a session token or any way to act as the target. Requires a fresh step-up challenge (viewing
   * another account's full detail is sensitive) and a reason, and is fully bounded/audited by an
   * explicit start/end pair.
   */
  async startImpersonation(
    ctx: ActingContext,
    targetUserId: string,
    reason: string,
  ): Promise<{ impersonationSessionId: string; view: AdminUserDetail }> {
    const target = await this.authorizeMutableTargetAllowAdmins(ctx, targetUserId);
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: ctx.actingUserId,
      sessionId: ctx.actingSessionId,
      action: "admin_impersonation_start",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to start a support view.");
    }
    if (!reason.trim()) {
      throw new ValidationError("A reason is required to start a support view.");
    }
    const detail = await this.deps.directory.getDetail(targetUserId);
    if (!detail) throw new ValidationError("User not found.");
    const session = await this.deps.impersonationSessions.insert({
      adminUserId: ctx.actingUserId,
      targetUserId,
      reason,
    });
    await this.recordAdminAudit(ctx, "admin_impersonation_started", targetUserId, reason, {
      impersonationSessionId: session.id,
      targetRole: target.platformRole,
    });
    return { impersonationSessionId: session.id, view: detail };
  }

  async endImpersonation(ctx: ActingContext, impersonationSessionId: string): Promise<void> {
    this.requireAdmin(ctx.actingRole);
    const session = await this.deps.impersonationSessions.findById(impersonationSessionId);
    if (!session || session.adminUserId !== ctx.actingUserId) {
      throw new ForbiddenError("This support-view session does not belong to you.");
    }
    if (session.endedAt) {
      throw new ValidationError("This support-view session has already ended.");
    }
    await this.deps.impersonationSessions.markEnded(session.id, new Date());
    await this.recordAdminAudit(ctx, "admin_impersonation_ended", session.targetUserId, null, {
      impersonationSessionId: session.id,
    });
  }

  private requireAdmin(role: PlatformRole): void {
    if (!isAdminRole(role)) {
      throw new ForbiddenError("Administrative access is required.");
    }
  }

  /**
   * Shared guard for every mutating action except impersonation-start (which allows viewing a
   * platform_admin, just never a platform_owner and never oneself — see
   * authorizeMutableTargetAllowAdmins): actor must be an admin, may never target themselves, may
   * never target a platform_owner (ownership changes have no path through this service at all —
   * see changeUserRole's doc comment), and a plain platform_admin actor may only target ordinary
   * members, never another admin.
   */
  private async authorizeMutableTarget(ctx: ActingContext, targetUserId: string): Promise<AdminUserSummary> {
    this.requireAdmin(ctx.actingRole);
    if (targetUserId === ctx.actingUserId) {
      throw new ValidationError("You cannot perform this action on your own account.");
    }
    const target = await this.deps.directory.getSummary(targetUserId);
    if (!target) throw new ValidationError("User not found.");
    if (target.platformRole === "platform_owner") {
      throw new ForbiddenError("Platform Owner accounts cannot be modified through this action.");
    }
    if (!isOwnerRole(ctx.actingRole) && target.platformRole !== "member") {
      throw new ForbiddenError("Platform Admins may only act on Member accounts.");
    }
    return target;
  }

  /** Impersonation-start's slightly looser variant: a Platform Owner may start a read-only support view of a Platform Admin (never of another Owner, never of themselves). A plain admin still may only view Members. */
  private async authorizeMutableTargetAllowAdmins(ctx: ActingContext, targetUserId: string): Promise<AdminUserSummary> {
    this.requireAdmin(ctx.actingRole);
    if (targetUserId === ctx.actingUserId) {
      throw new ValidationError("You cannot start a support view of your own account.");
    }
    const target = await this.deps.directory.getSummary(targetUserId);
    if (!target) throw new ValidationError("User not found.");
    if (target.platformRole === "platform_owner") {
      throw new ForbiddenError("Platform Owner accounts cannot be viewed through this action.");
    }
    if (!isOwnerRole(ctx.actingRole) && target.platformRole !== "member") {
      throw new ForbiddenError("Platform Admins may only view Member accounts.");
    }
    return target;
  }

  private async recordAdminAudit(
    ctx: ActingContext,
    action: string,
    targetResourceId: string,
    reason: string | null,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId: ctx.actingUserId,
      actorRole: ctx.actingRole,
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: ctx.ipAddress,
      deviceInfo: ctx.deviceInfo,
      previousValue: null,
      newValue,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "user_account",
      targetResourceId,
    });
  }
}
