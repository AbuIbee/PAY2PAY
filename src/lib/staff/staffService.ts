import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { MfaService } from "@/lib/auth/mfaService";
import type { SessionRepository } from "@/lib/auth/authService";
import { generateOpaqueToken, hashOpaqueToken } from "@/lib/auth/token";
import { ConflictError, ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import type { EmailSender } from "@/lib/notify/emailSender";
import type { EquivalentRoleResolver } from "@/lib/organizations/legacyRoleMigration";
import { DEFAULT_ROLE_CAPABILITIES, HIGH_RISK_CAPABILITIES, isCapability } from "./capabilities";
import type { Capability, StaffRole } from "./capabilities";

export interface BusinessStaffMemberRecord {
  id: string;
  businessProfileId: string;
  userId: string;
  role: StaffRole;
  customRoleId: string | null;
  /**
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, later corrected by the
   * Final RBAC Authorization Cutover: the canonical organization_role assignment — the ONLY thing
   * `OrganizationPermissionService` reads for an authorization decision. Null means "not yet
   * migrated"; `OrganizationPermissionService` never writes this (an authorization question must
   * never modify authorization state) — `inviteStaff`/`acceptInvitation`/`updateStaffRole` below
   * resolve it explicitly at mutation time via `EquivalentRoleResolver`, and
   * `LegacyRoleMigrationService.migrateOrganization` is the separate, explicit bulk backfill for any
   * pre-existing row these mutation-time call sites never touched.
   */
  roleId: string | null;
  isAuthorizedRepresentative: boolean;
  removedAt: Date | null;
  createdAt: Date;
}

/** Real implementation: DrizzleBusinessStaffMemberRepository. */
export interface BusinessStaffMemberRepository {
  insert(input: {
    businessProfileId: string;
    userId: string;
    role: StaffRole;
    customRoleId: string | null;
    isAuthorizedRepresentative: boolean;
  }): Promise<BusinessStaffMemberRecord>;
  findById(id: string): Promise<BusinessStaffMemberRecord | null>;
  /** Excludes removed members — the single seam "removed staff lose access" relies on. */
  findActiveByBusinessAndUser(businessProfileId: string, userId: string): Promise<BusinessStaffMemberRecord | null>;
  listActiveByBusiness(businessProfileId: string): Promise<BusinessStaffMemberRecord[]>;
  /** "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 7/8: every organization this user may select as a workspace — the workspace selector's own listing source. */
  listActiveByUser(userId: string): Promise<BusinessStaffMemberRecord[]>;
  updateRole(id: string, input: { role: StaffRole; customRoleId: string | null }): Promise<void>;
  markRemoved(id: string, removedAt: Date): Promise<void>;
  /** "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 12: points this membership at its new organization_role row — additive, never removes the legacy `role` enum value (see organizationRoles.ts's own doc comment on the deliberately separate, later authorization cutover). */
  setRoleId(id: string, roleId: string): Promise<void>;
}

export interface CustomRoleRecord {
  id: string;
  businessProfileId: string;
  name: string;
  permissions: Capability[];
}

/** Real implementation: DrizzleCustomRoleRepository. */
export interface CustomRoleRepository {
  insert(input: { businessProfileId: string; name: string; permissions: Capability[] }): Promise<CustomRoleRecord>;
  findById(id: string): Promise<CustomRoleRecord | null>;
  update(id: string, input: { name?: string; permissions?: Capability[] }): Promise<void>;
  listByBusiness(businessProfileId: string): Promise<CustomRoleRecord[]>;
}

export type StaffInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface StaffInvitationRecord {
  id: string;
  businessProfileId: string;
  email: string;
  role: StaffRole;
  customRoleId: string | null;
  /**
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Section 6: the
   * organization-owned role this invitation will assign on acceptance — set by the new Invitations
   * flow (organization_role-based), left null by the legacy `StaffService.inviteStaff` flow (which
   * continues to assign only the legacy `role` enum). `acceptInvitation` copies this onto the new
   * membership when present, never fabricating one when absent.
   */
  roleId: string | null;
  invitedByUserId: string;
  tokenHash: string;
  status: StaffInvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Real implementation: DrizzleStaffInvitationRepository. */
export interface StaffInvitationRepository {
  insert(input: {
    businessProfileId: string;
    email: string;
    role: StaffRole;
    customRoleId: string | null;
    roleId?: string | null;
    invitedByUserId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<StaffInvitationRecord>;
  findByTokenHash(tokenHash: string): Promise<StaffInvitationRecord | null>;
  findPendingByBusinessAndEmail(businessProfileId: string, email: string): Promise<StaffInvitationRecord | null>;
  markAccepted(id: string, input: { acceptedByUserId: string; acceptedAt: Date }): Promise<void>;
  /** Custom RBAC Runtime Cutover, Section 12: the Invitations tab's own listing source. */
  listPendingForBusiness(businessProfileId: string): Promise<StaffInvitationRecord[]>;
  revoke(id: string, revokedAt: Date): Promise<void>;
}

/**
 * Minimal reader StaffService needs to bind an invitation acceptance to the
 * accepting account's real email — mirrors
 * src/lib/profiles/verificationService.ts's ProfileOwnerReader pattern
 * (a small, single-method interface rather than pulling in the whole
 * UserAccountRepository).
 */
export interface UserEmailReader {
  getEmailByUserId(userId: string): Promise<string | null>;
}

export interface StaffServiceOptions {
  appUrl: string;
  invitationTtlMs?: number;
}

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASSIGNABLE_ROLES: readonly StaffRole[] = ["OWNER", "FINANCE_ADMIN", "AR_MANAGER", "AR_AGENT", "VIEWER"];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md): staff
 * membership, invitations, RBAC/custom roles, and removal. Settlement/
 * balance-adjustment thresholds and dual/owner-required approval live in
 * approvalService.ts, which depends on this service's capability checks but
 * is not itself a dependency of this file.
 */
export class StaffService {
  constructor(
    private readonly staffMembers: BusinessStaffMemberRepository,
    private readonly customRoles: CustomRoleRepository,
    private readonly invitations: StaffInvitationRepository,
    private readonly sessions: SessionRepository,
    private readonly mfa: MfaService,
    private readonly userEmails: UserEmailReader,
    private readonly audit: AuditService,
    private readonly emailSender: EmailSender,
    private readonly options: StaffServiceOptions,
    /**
     * "Final RBAC Authorization Cutover", Step 5/6: resolves (creating if necessary) the
     * `organization_role` equivalent to a legacy `StaffRole`, so every new/changed legacy-role
     * membership gets a non-null `role_id` at mutation time rather than relying solely on the
     * separate bulk `LegacyRoleMigrationService.migrateOrganization` backfill.
     */
    private readonly equivalentRoles: EquivalentRoleResolver,
  ) {}

  /**
   * The single seam every capability-gated action in this service (and
   * approvalService.ts) goes through. "OWNER" always has every capability;
   * every other role uses DEFAULT_ROLE_CAPABILITIES. Custom roles are
   * deferred (see capabilities.ts's own doc comment) — a legacy
   * `customRoleId` on a row is never consulted for authorization.
   */
  async hasCapability(member: BusinessStaffMemberRecord, capability: Capability): Promise<boolean> {
    if (member.role === "OWNER") return true;
    return DEFAULT_ROLE_CAPABILITIES[member.role].includes(capability);
  }

  /** Cross-business isolation + "removed staff lose access" both live in findActiveByBusinessAndUser. */
  async requireActiveStaff(businessProfileId: string, userId: string): Promise<BusinessStaffMemberRecord> {
    const member = await this.staffMembers.findActiveByBusinessAndUser(businessProfileId, userId);
    if (!member) throw new ForbiddenError("You are not an active staff member of this business.");
    return member;
  }

  async requireCapability(
    businessProfileId: string,
    userId: string,
    capability: Capability,
  ): Promise<BusinessStaffMemberRecord> {
    const member = await this.requireActiveStaff(businessProfileId, userId);
    if (!(await this.hasCapability(member, capability))) {
      throw new ForbiddenError(`This action requires the "${capability}" permission.`);
    }
    return member;
  }

  async listStaff(businessProfileId: string, requestingUserId: string): Promise<BusinessStaffMemberRecord[]> {
    await this.requireActiveStaff(businessProfileId, requestingUserId);
    return this.staffMembers.listActiveByBusiness(businessProfileId);
  }

  /**
   * Dashboard consistency fix: a plain count, deliberately with NO active-staff authorization check
   * of its own. Business profile creation has never seeded an "owner" business_staff_member row for
   * the creating user (a separate, pre-existing gap, flagged in this iteration's completion report —
   * out of scope to fix broadly here), so a business owner viewing their own dashboard has no
   * staff_member row and fails requireActiveStaff every time, which previously made the whole
   * GET /api/dashboard/business request 403 before returning any summary data at all. Safe to expose
   * without its own gate here because the only caller (the business dashboard route) has *already*
   * independently verified the caller owns this exact business via
   * ProfileAccessService.resolveActiveProfile before this is ever reached.
   */
  async countActiveStaff(businessProfileId: string): Promise<number> {
    const staff = await this.staffMembers.listActiveByBusiness(businessProfileId);
    return staff.length;
  }

  async listCustomRoles(businessProfileId: string, requestingUserId: string): Promise<CustomRoleRecord[]> {
    await this.requireActiveStaff(businessProfileId, requestingUserId);
    return this.customRoles.listByBusiness(businessProfileId);
  }

  async inviteStaff(input: {
    businessProfileId: string;
    invitedByUserId: string;
    email: string;
    role: StaffRole;
    customRoleId?: string | null;
  }): Promise<StaffInvitationRecord> {
    const actor = await this.requireCapability(input.businessProfileId, input.invitedByUserId, "send_invitation");
    await this.assertAssignableRole(actor, input.role);

    const email = normalizeEmail(input.email);
    const existingPending = await this.invitations.findPendingByBusinessAndEmail(input.businessProfileId, email);
    if (existingPending) {
      throw new ConflictError("An invitation is already pending for this email address.");
    }

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + (this.options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS));
    // "Final RBAC Authorization Cutover", Step 5: resolve the equivalent organization_role up front so
    // this (legacy-role-flow) invitation never ends up with a null `roleId` pending acceptance.
    const roleId = await this.equivalentRoles.resolveOrCreateEquivalentRole(input.businessProfileId, input.role);
    const invitation = await this.invitations.insert({
      businessProfileId: input.businessProfileId,
      email,
      role: input.role,
      customRoleId: null, // custom roles are deferred — see capabilities.ts's own doc comment.
      roleId,
      invitedByUserId: input.invitedByUserId,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
    });

    const link = `${this.options.appUrl}/staff/accept-invitation?token=${rawToken}`;
    await this.emailSender.send({
      to: email,
      subject: "You've been invited to join a PAY2PAY business account",
      body: `You've been invited to join a business team on PAY2PAY as ${input.role}. Accept the invitation: ${link}\n\nThis link expires in 7 days.`,
    });

    await this.recordAudit(input.businessProfileId, input.invitedByUserId, "staff_invitation_created", null, {
      email,
      role: input.role,
    });
    return invitation;
  }

  async acceptInvitation(rawToken: string, acceptingUserId: string): Promise<BusinessStaffMemberRecord> {
    const invitation = await this.invitations.findByTokenHash(hashOpaqueToken(rawToken));
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("This invitation is invalid or has expired.");
    }

    const acceptingEmail = await this.userEmails.getEmailByUserId(acceptingUserId);
    if (!acceptingEmail || normalizeEmail(acceptingEmail) !== invitation.email) {
      throw new ForbiddenError("This invitation was issued to a different email address.");
    }

    const existing = await this.staffMembers.findActiveByBusinessAndUser(invitation.businessProfileId, acceptingUserId);
    if (existing) {
      throw new ConflictError("You are already an active staff member of this business.");
    }

    const member = await this.staffMembers.insert({
      businessProfileId: invitation.businessProfileId,
      userId: acceptingUserId,
      role: invitation.role,
      customRoleId: invitation.customRoleId,
      isAuthorizedRepresentative: false,
    });
    // Custom RBAC Runtime Cutover, Section 6 / Final RBAC Authorization Cutover, Step 5: the
    // resulting membership must never end up with a null `role_id`. `inviteStaff` now always sets
    // `invitation.roleId` up front; this fallback only matters for invitations that were already
    // pending before that change shipped.
    const roleId = invitation.roleId ?? (await this.equivalentRoles.resolveOrCreateEquivalentRole(invitation.businessProfileId, invitation.role));
    await this.staffMembers.setRoleId(member.id, roleId);

    const acceptedAt = new Date();
    await this.invitations.markAccepted(invitation.id, { acceptedByUserId: acceptingUserId, acceptedAt });
    await this.recordAudit(invitation.businessProfileId, acceptingUserId, "staff_invitation_accepted", null, {
      role: invitation.role,
    });
    return { ...member, roleId };
  }

  /**
   * "Immediate session/access revocation where necessary." A high-risk
   * removal (the target holds a HIGH_RISK_CAPABILITIES capability) requires
   * a fresh step-up per this sprint's "staff removal affecting high-risk
   * capabilities" text; routine removals do not.
   */
  async removeStaff(input: {
    businessProfileId: string;
    actingUserId: string;
    actingSessionId: string;
    targetStaffId: string;
  }): Promise<void> {
    await this.requireCapability(input.businessProfileId, input.actingUserId, "manage_staff");
    const target = await this.getActiveStaffInBusiness(input.businessProfileId, input.targetStaffId);

    const isHighRisk = await this.memberHasAnyCapability(target, HIGH_RISK_CAPABILITIES);
    if (isHighRisk) {
      const stepUpOk = await this.mfa.requireStepUp({
        userId: input.actingUserId,
        sessionId: input.actingSessionId,
        action: "staff_removal",
      });
      if (!stepUpOk) {
        throw new StepUpRequiredError("Step-up verification is required to remove this staff member.");
      }
    }

    const removedAt = new Date();
    await this.staffMembers.markRemoved(target.id, removedAt);
    await this.sessions.revokeAllForUser(target.userId);

    await this.recordAudit(
      input.businessProfileId,
      input.actingUserId,
      "staff_removed",
      isHighRisk ? "step_up" : null,
      { targetStaffId: target.id, targetUserId: target.userId, role: target.role },
    );
  }

  /**
   * Role/custom-role changes ("permission changes") always require a fresh
   * step-up per this sprint's text, regardless of whether the specific
   * capability delta is high-risk. Two guards prevent the required test
   * scenarios: self-promotion (a staff member can never change their own
   * role) and privilege escalation (only an existing owner can grant the
   * "owner" role to someone else).
   */
  async updateStaffRole(input: {
    businessProfileId: string;
    actingUserId: string;
    actingSessionId: string;
    targetStaffId: string;
    newRole: StaffRole;
    newCustomRoleId?: string | null;
  }): Promise<void> {
    const actor = await this.requireCapability(input.businessProfileId, input.actingUserId, "manage_staff");
    const target = await this.getActiveStaffInBusiness(input.businessProfileId, input.targetStaffId);

    if (target.userId === input.actingUserId) {
      throw new ForbiddenError("You cannot change your own role.");
    }
    await this.assertAssignableRole(actor, input.newRole);

    const stepUpOk = await this.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "staff_role_change",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to change a staff member's role.");
    }

    // Custom roles are deferred (see capabilities.ts's own doc comment) — never set going forward.
    await this.staffMembers.updateRole(target.id, { role: input.newRole, customRoleId: null });
    // "Final RBAC Authorization Cutover", Step 5: a legacy role CHANGE must also repoint `role_id` at
    // the new legacy role's equivalent — otherwise the membership would keep resolving permissions
    // for its PREVIOUS role until the next bulk migration run.
    const roleId = await this.equivalentRoles.resolveOrCreateEquivalentRole(input.businessProfileId, input.newRole);
    await this.staffMembers.setRoleId(target.id, roleId);
    await this.recordAudit(input.businessProfileId, input.actingUserId, "staff_role_updated", "step_up", {
      targetStaffId: target.id,
      previousRole: target.role,
      newRole: input.newRole,
    });
  }

  async createCustomRole(input: {
    businessProfileId: string;
    actingUserId: string;
    actingSessionId: string;
    name: string;
    permissions: string[];
  }): Promise<CustomRoleRecord> {
    await this.requireCapability(input.businessProfileId, input.actingUserId, "manage_staff");
    const permissions = this.validatePermissions(input.permissions);
    if (!input.name.trim()) throw new ValidationError("A custom role name is required.");

    const stepUpOk = await this.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "custom_role_edit",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to create a custom role.");
    }

    const role = await this.customRoles.insert({
      businessProfileId: input.businessProfileId,
      name: input.name.trim(),
      permissions,
    });
    await this.recordAudit(input.businessProfileId, input.actingUserId, "custom_role_created", "step_up", {
      customRoleId: role.id,
      permissions,
    });
    return role;
  }

  async updateCustomRole(input: {
    businessProfileId: string;
    actingUserId: string;
    actingSessionId: string;
    customRoleId: string;
    name?: string;
    permissions?: string[];
  }): Promise<void> {
    await this.requireCapability(input.businessProfileId, input.actingUserId, "manage_staff");
    const role = await this.customRoles.findById(input.customRoleId);
    if (!role || role.businessProfileId !== input.businessProfileId) {
      throw new ForbiddenError("This custom role does not belong to this business.");
    }

    const stepUpOk = await this.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "custom_role_edit",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError("Step-up verification is required to edit a custom role.");
    }

    const permissions = input.permissions ? this.validatePermissions(input.permissions) : undefined;
    await this.customRoles.update(role.id, { name: input.name?.trim(), permissions });
    await this.recordAudit(input.businessProfileId, input.actingUserId, "custom_role_updated", "step_up", {
      customRoleId: role.id,
    });
  }

  private validatePermissions(permissions: string[]): Capability[] {
    for (const permission of permissions) {
      if (!isCapability(permission)) {
        throw new ValidationError(`"${permission}" is not a recognized capability.`);
      }
    }
    return permissions as Capability[];
  }

  private async memberHasAnyCapability(
    member: BusinessStaffMemberRecord,
    capabilities: readonly Capability[],
  ): Promise<boolean> {
    for (const capability of capabilities) {
      if (await this.hasCapability(member, capability)) return true;
    }
    return false;
  }

  /** Cross-business access guard shared by removeStaff/updateStaffRole. */
  private async getActiveStaffInBusiness(businessProfileId: string, staffId: string): Promise<BusinessStaffMemberRecord> {
    const target = await this.staffMembers.findById(staffId);
    if (!target || target.businessProfileId !== businessProfileId || target.removedAt) {
      throw new ForbiddenError("This staff member does not belong to this business.");
    }
    return target;
  }

  /**
   * Only an existing OWNER may grant the OWNER role — the privilege-
   * escalation guard (TEST requirement: AR_AGENT/VIEWER privilege escalation
   * must fail). Custom roles are deferred (see capabilities.ts's own doc
   * comment) — no custom-role-ownership branch exists anymore.
   */
  private async assertAssignableRole(actor: BusinessStaffMemberRecord, role: StaffRole): Promise<void> {
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new ValidationError(`"${role}" is not a recognized staff role.`);
    }
    if (role === "OWNER" && actor.role !== "OWNER") {
      throw new ForbiddenError("Only an existing owner can grant the owner role.");
    }
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
