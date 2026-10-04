import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getServerEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { businessStaffInvitation, businessStaffMember, organizationRole, organizationRolePermission } from "@/db/schema";
import { appendAuditEventTxBound } from "@/lib/audit/drizzleAuditEventRepository";
import { computeAuditEventHash, type AuditEventPayload } from "@/lib/audit/hash";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { OrganizationAuditedMutations, RolePermissionInput } from "./organizationAuditedMutations";
import { isPermissionKey, isScopeSupportedForPermission, type PermissionScope } from "./permissionCatalog";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function auditPayload(organizationId: string, actorUserId: string, action: string, newValue: unknown, previousValue: unknown = null): AuditEventPayload {
  return {
    actorUserId,
    actorRole: "business_staff",
    profileKind: "business",
    profileId: organizationId,
    agreementId: null,
    action,
    occurredAt: new Date().toISOString(),
    ipAddress: null,
    deviceInfo: null,
    previousValue,
    newValue,
    reason: null,
    authStrength: null,
    relatedDocumentId: null,
    relatedCaseId: null,
  };
}

function computeHashFor(payload: AuditEventPayload): (previousEventHash: string | null) => string {
  const { AUDIT_HASH_SECRET } = getServerEnv();
  return (previousEventHash: string | null) => computeAuditEventHash(payload, previousEventHash, AUDIT_HASH_SECRET);
}

function validatePermissions(permissions: readonly RolePermissionInput[]): void {
  for (const p of permissions) {
    if (!isPermissionKey(p.permissionKey)) throw new ValidationError(`"${p.permissionKey}" is not a recognized permission.`);
    if (!isScopeSupportedForPermission(p.permissionKey, p.scope)) {
      throw new ValidationError(`The "${p.scope}" scope is not yet supported for "${p.permissionKey}".`);
    }
  }
}

async function requireOrdinaryRoleForOrganization(tx: Tx, organizationId: string, roleId: string) {
  const rows = await tx
    .select()
    .from(organizationRole)
    .where(and(eq(organizationRole.id, roleId), eq(organizationRole.organizationId, organizationId)))
    .limit(1);
  const role = rows[0];
  if (!role) throw new ValidationError("This role does not belong to this organization.");
  return role;
}

async function activeProtectedOwnerCount(tx: Tx, organizationId: string, excludingMembershipId?: string): Promise<number> {
  const members = await tx
    .select({ id: businessStaffMember.id, roleId: businessStaffMember.roleId })
    .from(businessStaffMember)
    .where(and(eq(businessStaffMember.businessProfileId, organizationId), isNull(businessStaffMember.removedAt)));

  let count = 0;
  for (const member of members) {
    if (excludingMembershipId && member.id === excludingMembershipId) continue;
    if (!member.roleId) continue;
    const roleRows = await tx.select({ isOwnerRole: organizationRole.isOwnerRole }).from(organizationRole).where(eq(organizationRole.id, member.roleId)).limit(1);
    if (roleRows[0]?.isOwnerRole) count += 1;
  }
  return count;
}

async function requireActiveMemberInOrganization(tx: Tx, organizationId: string, targetMembershipId: string) {
  const rows = await tx.select().from(businessStaffMember).where(eq(businessStaffMember.id, targetMembershipId)).limit(1);
  const target = rows[0];
  if (!target || target.businessProfileId !== organizationId || target.removedAt) {
    throw new ValidationError("This team member does not belong to this organization.");
  }
  return target;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover: the real,
 * Postgres-transactional `OrganizationAuditedMutations` — each method is one `db.transaction()`
 * mirroring `drizzleAccountProvisioningRepository.ts`'s own established "raw Drizzle writes inside one
 * transaction" pattern, and reuses `appendAuditEventTxBound` exactly as `FailedPaymentRetryCoordinator`
 * does for its own in-transaction audit writes — never a second, competing audit-append
 * implementation. Deliberately NOT built on `OrganizationRoleService` (whose methods are each their
 * own implicit transaction against `getDb()`) — that remains the correct seam for any mutation NOT in
 * the six-event mandatory list (e.g. `updateDescription`). The former `OrganizationMembershipService`
 * (the Team Members tab's pre-cutover mutation seam) is fully superseded by this class and has been
 * removed — `/api/organizations/members` now calls this interface directly.
 */
export class DrizzleOrganizationAuditedMutations implements OrganizationAuditedMutations {
  async createRole(input: { organizationId: string; actorUserId: string; displayName: string; description: string | null; permissions: readonly RolePermissionInput[] }) {
    if (!input.displayName.trim()) throw new ValidationError("A role name is required.");
    validatePermissions(input.permissions);

    const db = getDb();
    return db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: organizationRole.id })
        .from(organizationRole)
        .where(and(eq(organizationRole.organizationId, input.organizationId), eq(organizationRole.displayName, input.displayName)))
        .limit(1);
      if (existing[0]) throw new ValidationError(`A role named "${input.displayName}" already exists for this organization.`);

      const [role] = await tx
        .insert(organizationRole)
        .values({ organizationId: input.organizationId, displayName: input.displayName, description: input.description, isOwnerRole: false, isProtected: false, sortOrder: 100 })
        .returning();
      if (!role) throw new ValidationError("Could not create this role.");

      for (const p of input.permissions) {
        await tx.insert(organizationRolePermission).values({ roleId: role.id, permissionKey: p.permissionKey, scope: p.scope });
      }

      const payload = auditPayload(input.organizationId, input.actorUserId, "organization_role_created", { roleId: role.id, displayName: role.displayName, permissions: input.permissions });
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));

      return { id: role.id, displayName: role.displayName };
    });
  }

  async renameRole(input: { organizationId: string; actorUserId: string; roleId: string; displayName: string }): Promise<void> {
    if (!input.displayName.trim()) throw new ValidationError("A role name is required.");

    const db = getDb();
    await db.transaction(async (tx) => {
      const role = await requireOrdinaryRoleForOrganization(tx, input.organizationId, input.roleId);
      const duplicate = await tx
        .select({ id: organizationRole.id })
        .from(organizationRole)
        .where(and(eq(organizationRole.organizationId, input.organizationId), eq(organizationRole.displayName, input.displayName), ne(organizationRole.id, input.roleId)))
        .limit(1);
      if (duplicate[0]) throw new ValidationError(`A role named "${input.displayName}" already exists for this organization.`);

      await tx.update(organizationRole).set({ displayName: input.displayName, updatedAt: new Date() }).where(eq(organizationRole.id, input.roleId));

      const payload = auditPayload(
        input.organizationId,
        input.actorUserId,
        "organization_role_renamed",
        { roleId: role.id, displayName: input.displayName },
        { roleId: role.id, displayName: role.displayName },
      );
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));
    });
  }

  async changeRolePermission(input: { organizationId: string; actorUserId: string; roleId: string; permissionKey: string; scope: PermissionScope; grant: boolean }): Promise<void> {
    if (input.grant) validatePermissions([{ permissionKey: input.permissionKey, scope: input.scope }]);
    else if (!isPermissionKey(input.permissionKey)) throw new ValidationError(`"${input.permissionKey}" is not a recognized permission.`);

    const db = getDb();
    await db.transaction(async (tx) => {
      const role = await requireOrdinaryRoleForOrganization(tx, input.organizationId, input.roleId);
      if (role.isProtected) throw new ForbiddenError("This role's permissions are protected and cannot be edited individually.");

      if (input.grant) {
        await tx.insert(organizationRolePermission).values({ roleId: role.id, permissionKey: input.permissionKey, scope: input.scope });
      } else {
        await tx.delete(organizationRolePermission).where(and(eq(organizationRolePermission.roleId, role.id), eq(organizationRolePermission.permissionKey, input.permissionKey)));
      }

      const payload = auditPayload(input.organizationId, input.actorUserId, "organization_role_permission_changed", {
        roleId: role.id,
        permissionKey: input.permissionKey,
        scope: input.scope,
        granted: input.grant,
      });
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));
    });
  }

  async inviteMember(input: { organizationId: string; actorUserId: string; email: string; roleId: string; tokenHash: string; expiresAt: Date }) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const roleRows = await tx
        .select()
        .from(organizationRole)
        .where(and(eq(organizationRole.id, input.roleId), eq(organizationRole.organizationId, input.organizationId)))
        .limit(1);
      const role = roleRows[0];
      if (!role) throw new ValidationError("This role does not belong to this organization.");

      const existingPending = await tx
        .select({ id: businessStaffInvitation.id })
        .from(businessStaffInvitation)
        .where(and(eq(businessStaffInvitation.businessProfileId, input.organizationId), eq(businessStaffInvitation.email, input.email), eq(businessStaffInvitation.status, "pending")))
        .limit(1);
      if (existingPending[0]) throw new ConflictError("An invitation is already pending for this email address.");

      const [invitation] = await tx
        .insert(businessStaffInvitation)
        .values({
          businessProfileId: input.organizationId,
          email: input.email,
          role: "VIEWER",
          customRoleId: null,
          roleId: role.id,
          invitedByUserId: input.actorUserId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!invitation) throw new ValidationError("Could not create this invitation.");

      const payload = auditPayload(input.organizationId, input.actorUserId, "organization_member_invited", { email: input.email, roleId: role.id });
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));

      return { id: invitation.id, email: invitation.email, roleId: invitation.roleId };
    });
  }

  async changeMemberRole(input: { organizationId: string; actorUserId: string; targetMembershipId: string; newRoleId: string }): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      const target = await requireActiveMemberInOrganization(tx, input.organizationId, input.targetMembershipId);
      if (target.userId === input.actorUserId) throw new ForbiddenError("You cannot change your own role.");

      const roleRows = await tx
        .select()
        .from(organizationRole)
        .where(and(eq(organizationRole.id, input.newRoleId), eq(organizationRole.organizationId, input.organizationId)))
        .limit(1);
      const newRole = roleRows[0];
      if (!newRole) throw new ValidationError("This role does not belong to this organization.");

      if (!newRole.isOwnerRole) {
        const isCurrentlyOwner = target.roleId
          ? (await tx.select({ isOwnerRole: organizationRole.isOwnerRole }).from(organizationRole).where(eq(organizationRole.id, target.roleId)).limit(1))[0]?.isOwnerRole
          : false;
        if (isCurrentlyOwner) {
          const otherOwners = await activeProtectedOwnerCount(tx, input.organizationId, target.id);
          if (otherOwners === 0) throw new ForbiddenError("This organization must always have at least one Owner — reassign another member to Owner first.");
        }
      }

      await tx.update(businessStaffMember).set({ roleId: newRole.id, updatedAt: new Date() }).where(eq(businessStaffMember.id, target.id));

      const payload = auditPayload(
        input.organizationId,
        input.actorUserId,
        "organization_member_role_changed",
        { targetMembershipId: target.id, targetUserId: target.userId, roleId: newRole.id },
        { roleId: target.roleId },
      );
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));
    });
  }

  async removeMember(input: { organizationId: string; actorUserId: string; targetMembershipId: string }): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      const target = await requireActiveMemberInOrganization(tx, input.organizationId, input.targetMembershipId);
      if (target.userId === input.actorUserId) throw new ForbiddenError("You cannot remove yourself.");

      const isOwner = target.roleId
        ? (await tx.select({ isOwnerRole: organizationRole.isOwnerRole }).from(organizationRole).where(eq(organizationRole.id, target.roleId)).limit(1))[0]?.isOwnerRole
        : false;
      if (isOwner) {
        const otherOwners = await activeProtectedOwnerCount(tx, input.organizationId, target.id);
        if (otherOwners === 0) throw new ForbiddenError("The final Owner of an organization cannot be removed.");
      }

      const removedAt = new Date();
      await tx.update(businessStaffMember).set({ removedAt }).where(eq(businessStaffMember.id, target.id));

      const payload = auditPayload(input.organizationId, input.actorUserId, "organization_member_removed", { targetMembershipId: target.id, targetUserId: target.userId, roleId: target.roleId });
      await appendAuditEventTxBound(tx, payload, computeHashFor(payload));
    });
  }
}
