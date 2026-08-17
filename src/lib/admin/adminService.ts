import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { AccountClassification, PlatformRole, SessionRepository, UserAccountRepository } from "@/lib/auth/authService";
import type { MfaService } from "@/lib/auth/mfaService";
import type { BusinessProfileRepository, BusinessProfileStatus } from "@/lib/profiles/businessProfileService";
import { ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { isAdminRole, isOwnerRole } from "./capabilities";
import type { AdminEnvironmentStatus, EnvironmentStatusReader } from "./environmentStatus";

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
  // PRSprint 04: admin-only, secret-free provider/environment status — see environmentStatus.ts.
  environmentStatus: AdminEnvironmentStatus;
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

/** Real implementation: DrizzleAdminOverviewReader. Read-only aggregate queries only — environmentStatus is deliberately excluded here and merged in by AdminService.getDashboardOverview instead, since it is config-derived, not a DB metric. */
export interface AdminOverviewReader {
  getOverview(): Promise<Omit<AdminOverviewData, "environmentStatus">>;
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
  /**
   * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): before
   * this, an impersonation session that outlived its originating browser tab (a refresh, a
   * navigation away, a closed tab) became invisible to the UI — `impersonationSessionId` lived only
   * in that page's React state — while staying open (`endedAt: null`) on the server indefinitely,
   * with no way for the admin to rediscover or end it. That is exactly the "hidden persistent
   * support session" this PRSprint's own Goal names as something the architecture must not allow.
   * Used both to let the UI re-surface an admin's own still-open session after a reload, and by
   * `startImpersonation` to refuse starting a second concurrent one.
   */
  findActiveForAdmin(adminUserId: string): Promise<AdminImpersonationSessionRecord | null>;
}

export interface AdminBusinessSummary {
  id: string;
  legalBusinessName: string;
  displayName: string;
  status: BusinessProfileStatus;
  ownerUserId: string;
  ownerEmail: string;
  ownerPlatformRole: PlatformRole;
  createdAt: Date;
}

export interface AdminBusinessMember {
  userId: string;
  email: string;
  role: string;
  isAuthorizedRepresentative: boolean;
}

export interface AdminBusinessDetail extends AdminBusinessSummary {
  entityType: string;
  country: string;
  state: string;
  members: AdminBusinessMember[];
  agreements: { id: string; status: string; relationshipShape: string }[];
}

/** Real implementation: DrizzleAdminBusinessDirectoryReader. Read-only queries only — never mutates (mirrors AdminUserDirectoryReader's own doc comment). */
export interface AdminBusinessDirectoryReader {
  search(query: { name?: string; businessId?: string }): Promise<AdminBusinessSummary[]>;
  getSummary(businessId: string): Promise<AdminBusinessSummary | null>;
  getDetail(businessId: string): Promise<AdminBusinessDetail | null>;
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
  environmentStatus: EnvironmentStatusReader;
  // PRSprint 11B: business-admin support. `businesses` is only ever used here for its
  // `updateStatus` write (suspend/reactivate) — every read goes through the read-only
  // `businessDirectory`, mirroring how `users`/`directory` are split for the same reason.
  businesses: BusinessProfileRepository;
  businessDirectory: AdminBusinessDirectoryReader;
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
    const overview = await this.deps.overview.getOverview();
    return { ...overview, environmentStatus: this.deps.environmentStatus.getStatus() };
  }

  async searchUsers(actingRole: PlatformRole, query: { email?: string; userId?: string }): Promise<AdminUserSummary[]> {
    this.requireAdmin(actingRole);
    return this.deps.directory.search(query);
  }

  async getUserDetail(ctx: ActingContext, targetUserId: string): Promise<AdminUserDetail> {
    this.requireAdmin(ctx.actingRole);
    const detail = await this.deps.directory.getDetail(targetUserId);
    if (!detail) throw new ValidationError("User not found.");
    await this.recordAdminAudit(ctx, "admin_user_viewed", "user_account", targetUserId, null, null);
    return detail;
  }

  async suspendUser(ctx: ActingContext, targetUserId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    await this.requireFreshStepUp(ctx, "admin_user_suspend");
    if (target.status === "suspended") {
      throw new ValidationError("This account is already suspended.");
    }
    await this.deps.users.updateStatus(targetUserId, "suspended");
    // Suspension must take effect immediately, not just at the target's next login — revoking
    // every existing session closes that gap (AuthService.validateSession also independently
    // rejects a non-active status as defense in depth, but this is the primary mechanism).
    await this.deps.sessions.revokeAllForUser(targetUserId);
    await this.recordAdminAudit(ctx, "admin_user_suspended", "user_account", targetUserId, reason, { status: "suspended" });
  }

  async reactivateUser(ctx: ActingContext, targetUserId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableTarget(ctx, targetUserId);
    await this.requireFreshStepUp(ctx, "admin_user_reactivate");
    if (target.status === "active") {
      throw new ValidationError("This account is already active.");
    }
    await this.deps.users.updateStatus(targetUserId, "active");
    await this.recordAdminAudit(ctx, "admin_user_reactivated", "user_account", targetUserId, reason, { status: "active" });
  }

  /**
   * PRSprint 07 (docs/prsprints/PRSPRINT_07_PLATFORM_OWNER_ADMIN_SUPPORT_CONTROLS.md): reason is now
   * mandatory (was optional/nullable) — forcibly signing a user out of every device is exactly as
   * sensitive as suspend/reactivate/role-change, which have always required a reason; there is no
   * principled basis for this one action alone to skip it. Enforced by the route's zod schema
   * (`min(1)`, matching suspend/reactivate/role-change's own validation), not re-checked here, for
   * the same reason those three don't re-check it in the service either.
   */
  async revokeUserSessions(ctx: ActingContext, targetUserId: string, reason: string): Promise<void> {
    await this.authorizeMutableTarget(ctx, targetUserId);
    await this.requireFreshStepUp(ctx, "admin_sessions_revoke");
    await this.deps.sessions.revokeAllForUser(targetUserId);
    await this.recordAdminAudit(ctx, "admin_sessions_revoked", "user_account", targetUserId, reason, null);
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
    await this.requireFreshStepUp(ctx, "admin_role_change", "Step-up verification is required to change a platform role.");
    if (target.platformRole === newRole) {
      throw new ValidationError(`This account already has the "${newRole}" role.`);
    }
    await this.deps.users.updatePlatformRole(targetUserId, newRole);
    await this.recordAdminAudit(ctx, "admin_role_changed", "user_account", targetUserId, reason, {
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
    await this.recordAdminAudit(ctx, "admin_classification_changed", "user_account", targetUserId, null, {
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
    await this.requireFreshStepUp(ctx, "admin_impersonation_start", "Step-up verification is required to start a support view.");
    if (!reason.trim()) {
      throw new ValidationError("A reason is required to start a support view.");
    }
    // PRSprint 11B: at most one active support view per admin at a time — see
    // AdminImpersonationSessionRepository.findActiveForAdmin's doc comment for why an admin must
    // end their current session before starting another, rather than silently accumulating several
    // simultaneously-open ones.
    const existingActive = await this.deps.impersonationSessions.findActiveForAdmin(ctx.actingUserId);
    if (existingActive) {
      throw new ValidationError("You already have an active support view. End it before starting another.");
    }
    const detail = await this.deps.directory.getDetail(targetUserId);
    if (!detail) throw new ValidationError("User not found.");
    const session = await this.deps.impersonationSessions.insert({
      adminUserId: ctx.actingUserId,
      targetUserId,
      reason,
    });
    await this.recordAdminAudit(ctx, "admin_impersonation_started", "user_account", targetUserId, reason, {
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
    await this.recordAdminAudit(ctx, "admin_impersonation_ended", "user_account", session.targetUserId, null, {
      impersonationSessionId: session.id,
    });
  }

  /**
   * PRSprint 11B: lets the UI re-surface an admin's own still-open support view after a page
   * refresh or navigation elsewhere — see AdminImpersonationSessionRepository.findActiveForAdmin's
   * doc comment. A read-only status poll, not a new access grant (the session was already audited
   * when it started), so this deliberately does not itself write a new audit event on every check.
   */
  async getActiveImpersonation(
    ctx: ActingContext,
  ): Promise<{ impersonationSessionId: string; targetUserId: string; startedAt: Date; view: AdminUserDetail } | null> {
    this.requireAdmin(ctx.actingRole);
    const session = await this.deps.impersonationSessions.findActiveForAdmin(ctx.actingUserId);
    if (!session) return null;
    const view = await this.deps.directory.getDetail(session.targetUserId);
    if (!view) return null;
    return { impersonationSessionId: session.id, targetUserId: session.targetUserId, startedAt: session.startedAt, view };
  }

  private requireAdmin(role: PlatformRole): void {
    if (!isAdminRole(role)) {
      throw new ForbiddenError("Administrative access is required.");
    }
  }

  /**
   * PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): shared step-up
   * gate for every high-risk admin action — account suspend/reactivate/session-revoke joined
   * Sprint 6A's original role-change/impersonation-start callers here, since disabling or
   * re-enabling someone's account and forcibly signing them out are just as security-sensitive as
   * a role change, and previously had no step-up requirement at all.
   */
  private async requireFreshStepUp(
    ctx: ActingContext,
    action: string,
    message = "Step-up verification is required for this action.",
  ): Promise<void> {
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: ctx.actingUserId,
      sessionId: ctx.actingSessionId,
      action,
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError(message);
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

  async searchBusinesses(actingRole: PlatformRole, query: { name?: string; businessId?: string }): Promise<AdminBusinessSummary[]> {
    this.requireAdmin(actingRole);
    return this.deps.businessDirectory.search(query);
  }

  async getBusinessDetail(ctx: ActingContext, targetBusinessId: string): Promise<AdminBusinessDetail> {
    this.requireAdmin(ctx.actingRole);
    const detail = await this.deps.businessDirectory.getDetail(targetBusinessId);
    if (!detail) throw new ValidationError("Business not found.");
    await this.recordAdminAudit(ctx, "admin_business_viewed", "business_profile", targetBusinessId, null, null);
    return detail;
  }

  async suspendBusiness(ctx: ActingContext, targetBusinessId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableBusinessTarget(ctx, targetBusinessId);
    await this.requireFreshStepUp(ctx, "admin_business_suspend");
    if (target.status === "disabled") {
      throw new ValidationError("This business is already suspended.");
    }
    await this.deps.businesses.updateStatus(targetBusinessId, "disabled");
    await this.recordAdminAudit(ctx, "admin_business_suspended", "business_profile", targetBusinessId, reason, { status: "disabled" });
  }

  async reactivateBusiness(ctx: ActingContext, targetBusinessId: string, reason: string): Promise<void> {
    const target = await this.authorizeMutableBusinessTarget(ctx, targetBusinessId);
    await this.requireFreshStepUp(ctx, "admin_business_reactivate");
    if (target.status === "active") {
      throw new ValidationError("This business is already active.");
    }
    await this.deps.businesses.updateStatus(targetBusinessId, "active");
    await this.recordAdminAudit(ctx, "admin_business_reactivated", "business_profile", targetBusinessId, reason, { status: "active" });
  }

  /**
   * Business-target mirror of authorizeMutableTarget: a plain Platform Admin may only act on a
   * business owned by an ordinary Member, never one owned by another Platform Admin or a Platform
   * Owner — the same "no acting on a peer or superior's stuff" rule the user-targeting guard
   * enforces, applied to the owner of the business rather than the business itself (a business has
   * no platform role of its own).
   */
  private async authorizeMutableBusinessTarget(ctx: ActingContext, targetBusinessId: string): Promise<AdminBusinessSummary> {
    this.requireAdmin(ctx.actingRole);
    const target = await this.deps.businessDirectory.getSummary(targetBusinessId);
    if (!target) throw new ValidationError("Business not found.");
    if (!isOwnerRole(ctx.actingRole) && target.ownerPlatformRole !== "member") {
      throw new ForbiddenError("Platform Admins may only act on businesses owned by a Member account.");
    }
    return target;
  }

  private async recordAdminAudit(
    ctx: ActingContext,
    action: string,
    targetResourceType: string,
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
      targetResourceType,
      targetResourceId,
    });
  }
}
