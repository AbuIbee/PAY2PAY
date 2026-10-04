import "server-only";
import { ForbiddenError } from "@/lib/errors";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import type { BusinessStaffMemberRecord, BusinessStaffMemberRepository } from "@/lib/staff/staffService";
import type { OrganizationRoleRecord, OrganizationRoleRepository } from "./organizationRoleRepository";

export interface OrganizationPermissionContext {
  membership: BusinessStaffMemberRecord;
  /** Null when role_id is unset, or names a role that does not belong to this membership's own organization. Either case fails closed — never a fallback read of the legacy role enum. */
  role: OrganizationRoleRecord | null;
  permissionKeys: ReadonlySet<string>;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover: the ONE canonical,
 * READ-ONLY server-side permission evaluation path — `membership.role_id -> organization_role ->
 * organization_role_permission -> permission key`. Every organization route calls `can`/`require`/
 * `isProtectedOwner` here, never `OrganizationAuthorizationService.canReadOrganizationResource` (the
 * prior transitional capability boundary, kept only as a legacy/historical artifact — see that class's
 * own doc comment), never a bare comparison against `role.displayName`, and — as of this cutover —
 * never the legacy `organization_role` enum column (`membership.role`) either.
 *
 * NO SELF-HEALING: an authorization question must never modify authorization state. A membership with
 * a null, invalid, or cross-tenant `role_id` is DENIED, full stop — it is never backfilled, repaired,
 * or defaulted from here. Legacy-data correction is an explicit, separate, pre-authorization step (see
 * `legacyRoleMigration.ts` and `organizationAuditedMutations.ts`'s own `inviteMemberAudited`/
 * `changeMemberRoleAudited`, which maintain `role_id` at MUTATION time, atomically with the write that
 * changes it — never lazily, from inside a read-only permission check).
 *
 * Fails closed throughout: no organization, no active membership, no role, no permission -> denied.
 * Never trusts a client-supplied organizationId/role_id/permission/scope — every check re-resolves
 * from the database on every call.
 */
export class OrganizationPermissionService {
  constructor(
    private readonly businessProfiles: BusinessProfileRepository,
    private readonly staffMembers: BusinessStaffMemberRepository,
    private readonly roles: OrganizationRoleRepository,
  ) {}

  async resolveActiveMembership(userId: string, organizationId: string): Promise<BusinessStaffMemberRecord | null> {
    const org = await this.businessProfiles.findById(organizationId);
    if (!org || org.status !== "active") return null;
    return this.staffMembers.findActiveByBusinessAndUser(organizationId, userId);
  }

  async resolveContextForMembership(membership: BusinessStaffMemberRecord): Promise<OrganizationPermissionContext> {
    if (!membership.roleId) {
      return { membership, role: null, permissionKeys: new Set() };
    }
    // Tenant-scoped lookup: a role_id that (through data corruption, or a bug elsewhere) names a role
    // belonging to a DIFFERENT organization than this membership resolves to null here, never silently
    // authorized against the wrong organization's role.
    const role = await this.roles.findRoleForOrganization(membership.businessProfileId, membership.roleId);
    if (!role) {
      return { membership, role: null, permissionKeys: new Set() };
    }
    const permissions = await this.roles.listPermissionsForRole(role.id);
    return { membership, role, permissionKeys: new Set(permissions.map((p) => p.permissionKey)) };
  }

  /**
   * Protected Owner is a structural flag on the role row (`isOwnerRole`), never `displayName`, never
   * the legacy `role` enum, never inferred from "holds every permission." See organizationRoleService.
   * ts's own invariant: `isOwnerRole` is set exactly once, at seed time, and no rename/permission-edit
   * method can flip it. A membership with no resolvable role is never treated as Owner, protected or
   * otherwise.
   */
  async isProtectedOwner(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.resolveActiveMembership(userId, organizationId);
    if (!membership) return false;
    const context = await this.resolveContextForMembership(membership);
    return context.role?.isOwnerRole ?? false;
  }

  async can(userId: string, organizationId: string, permissionKey: string): Promise<boolean> {
    const membership = await this.resolveActiveMembership(userId, organizationId);
    if (!membership) return false;
    return this.membershipCan(membership, permissionKey);
  }

  /** For callers that already hold a freshly-resolved membership (avoids a redundant membership lookup). */
  async membershipCan(membership: BusinessStaffMemberRecord, permissionKey: string): Promise<boolean> {
    const context = await this.resolveContextForMembership(membership);
    if (context.role?.isOwnerRole) return true;
    return context.permissionKeys.has(permissionKey);
  }

  async require(userId: string, organizationId: string, permissionKey: string): Promise<BusinessStaffMemberRecord> {
    const membership = await this.resolveActiveMembership(userId, organizationId);
    if (!membership) throw new ForbiddenError("You do not have access to this organization.");
    if (!(await this.membershipCan(membership, permissionKey))) {
      throw new ForbiddenError(`This action requires the "${permissionKey}" permission.`);
    }
    return membership;
  }
}
