import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ValidationError } from "@/lib/errors";
import { DrizzleOrganizationRoleRepository } from "@/lib/organizations/drizzleOrganizationRoleRepository";
import { getOrganizationAuditedMutations } from "@/lib/organizations/getOrganizationAuditedMutations";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { getOrganizationRoleService } from "@/lib/organizations/getOrganizationRoleService";
import type { OrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutations";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import type { OrganizationRoleRepository } from "@/lib/organizations/organizationRoleRepository";
import type { OrganizationRoleService } from "@/lib/organizations/organizationRoleService";
import { PERMISSION_CATALOG } from "@/lib/organizations/permissionCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = ["organization", "assigned", "own", "team", "none"] as const;
const permissionInputSchema = z.object({ permissionKey: z.string().min(1).max(100), scope: z.enum(SCOPES) });

const listQuerySchema = z.object({ organizationId: z.string().uuid() });
const createSchema = z.object({
  organizationId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  permissions: z.array(permissionInputSchema).max(200),
});
const patchSchema = z.object({
  organizationId: z.string().uuid(),
  roleId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
const deleteSchema = z.object({ organizationId: z.string().uuid(), roleId: z.string().uuid(), reassignToRoleId: z.string().uuid().optional() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 13/14/15/16/18: the
 * Roles & Permissions tab's own CRUD routes — a thin HTTP layer over the existing, already-tested
 * `OrganizationRoleService` (create/rename/describe/delete/assign-permission), gated on the canonical
 * `OrganizationPermissionService` (roles.view/create/edit/delete). `OrganizationRoleService` itself
 * already enforces every protected-Owner invariant (an ordinary role creation can never set
 * is_owner_role/is_protected; the Owner role can never be deleted) — never duplicated here.
 */
export function createRolesGetHandler(authService: AuthService, permissions: OrganizationPermissionService, roles: OrganizationRoleService, roleRepository: OrganizationRoleRepository) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.view");
    const rolesWithPermissions = await roles.listRolesWithPermissions(parsed.data.organizationId);
    const withCounts = await Promise.all(
      rolesWithPermissions.map(async ({ role, permissions: perms }) => ({
        id: role.id,
        displayName: role.displayName,
        description: role.description,
        isOwnerRole: role.isOwnerRole,
        isProtected: role.isProtected,
        memberCount: await roleRepository.countActiveMembersForRole(role.id),
        permissions: perms.map((p) => ({ permissionKey: p.permissionKey, scope: p.scope })),
      })),
    );
    return NextResponse.json({ catalog: PERMISSION_CATALOG, roles: withCounts }, { status: 200 });
  };
}

/** ROLE_CREATED is one of the six mandatory-audited mutations — atomic with its own write. */
export function createRolesPostHandler(authService: AuthService, permissions: OrganizationPermissionService, mutations: OrganizationAuditedMutations) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid role is required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.create");
    const role = await mutations.createRole({
      organizationId: parsed.data.organizationId,
      actorUserId: userId,
      displayName: parsed.data.displayName,
      description: parsed.data.description ?? null,
      permissions: parsed.data.permissions,
    });
    return NextResponse.json({ id: role.id, displayName: role.displayName }, { status: 201 });
  };
}

/** ROLE_RENAMED is one of the six mandatory-audited mutations — atomic with its own write. Description-only edits are not mandatory-audited and stay on the plain service. */
export function createRolesPatchHandler(authService: AuthService, permissions: OrganizationPermissionService, roles: OrganizationRoleService, mutations: OrganizationAuditedMutations) {
  return async function handlePatch(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId and roleId are required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.edit");
    if (parsed.data.displayName !== undefined) {
      await mutations.renameRole({ organizationId: parsed.data.organizationId, actorUserId: userId, roleId: parsed.data.roleId, displayName: parsed.data.displayName });
    }
    if (parsed.data.description !== undefined) {
      await roles.updateDescription(parsed.data.organizationId, parsed.data.roleId, parsed.data.description);
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

/** ROLE_DELETED — not in the six mandatory-audited events; audited best-effort (never blocks the deletion itself). */
export function createRolesDeleteHandler(authService: AuthService, permissions: OrganizationPermissionService, roles: OrganizationRoleService, audit: AuditService) {
  return async function handleDelete(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = deleteSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId and roleId are required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.delete");
    await roles.deleteRole(parsed.data.organizationId, parsed.data.roleId, parsed.data.reassignToRoleId);
    await audit
      .record({
        actorUserId: userId,
        actorRole: "business_staff",
        profileKind: "business",
        profileId: parsed.data.organizationId,
        agreementId: null,
        action: "organization_role_deleted",
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: { roleId: parsed.data.roleId },
        newValue: null,
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
      })
      .catch(() => {});
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createRolesGetHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationRoleService(), new DrizzleOrganizationRoleRepository())(request);
}
async function handlePost(request: NextRequest): Promise<Response> {
  return createRolesPostHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationAuditedMutations())(request);
}
async function handlePatch(request: NextRequest): Promise<Response> {
  return createRolesPatchHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationRoleService(), getOrganizationAuditedMutations())(request);
}
async function handleDelete(request: NextRequest): Promise<Response> {
  return createRolesDeleteHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationRoleService(), new AuditService(new DrizzleAuditEventRepository()))(request);
}

export const GET = withErrorHandling("organizations_roles_get", handleGet);
export const POST = withErrorHandling("organizations_roles_post", handlePost);
export const PATCH = withErrorHandling("organizations_roles_patch", handlePatch);
export const DELETE = withErrorHandling("organizations_roles_delete", handleDelete);
