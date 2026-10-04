import "server-only";
import type { PermissionScope } from "./permissionCatalog";

export interface RolePermissionInput {
  permissionKey: string;
  scope: PermissionScope;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Steps 21-23: the
 * interface for the six mandatory RBAC audit events (ROLE_CREATED, ROLE_RENAMED,
 * ROLE_PERMISSION_CHANGED, MEMBER_INVITED, MEMBER_ROLE_CHANGED, MEMBER_REMOVED), each required to
 * commit atomically with its own business mutation. Mirrors this codebase's established
 * interface-plus-two-implementations pattern (one real/Postgres-transactional, one in-memory for
 * ordinary unit tests) rather than tying every call site to a live database connection.
 *
 * `DrizzleOrganizationAuditedMutations` (organizationAuditedMutationsDrizzle.ts) is the real,
 * Postgres-transactional implementation — true atomicity is proven only there and in its own
 * `.postgres.test.ts`, never claimed by the in-memory fake (`organizationAuditedMutationsTestFakes.ts`),
 * which cannot meaningfully test real transaction rollback at all.
 *
 * Authorization is NOT this interface's concern — every method assumes the caller has already run
 * `OrganizationPermissionService.require(...)` (read-only) before calling. These methods re-validate
 * the same business invariants those services already enforce (duplicate name, protected-role,
 * catalog/scope validity, tenant-scoped role lookup, last-Owner protection) so a concurrent
 * conflicting write cannot slip in between the check and the write within one atomic unit.
 */
export interface OrganizationAuditedMutations {
  createRole(input: { organizationId: string; actorUserId: string; displayName: string; description: string | null; permissions: readonly RolePermissionInput[] }): Promise<{ id: string; displayName: string }>;

  renameRole(input: { organizationId: string; actorUserId: string; roleId: string; displayName: string }): Promise<void>;

  changeRolePermission(input: { organizationId: string; actorUserId: string; roleId: string; permissionKey: string; scope: PermissionScope; grant: boolean }): Promise<void>;

  inviteMember(input: { organizationId: string; actorUserId: string; email: string; roleId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string; email: string; roleId: string | null }>;

  changeMemberRole(input: { organizationId: string; actorUserId: string; targetMembershipId: string; newRoleId: string }): Promise<void>;

  removeMember(input: { organizationId: string; actorUserId: string; targetMembershipId: string }): Promise<void>;
}
