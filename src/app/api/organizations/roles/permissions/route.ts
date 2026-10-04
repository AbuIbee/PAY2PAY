import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getOrganizationAuditedMutations } from "@/lib/organizations/getOrganizationAuditedMutations";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutations";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = ["organization", "assigned", "own", "team", "none"] as const;
const assignSchema = z.object({ organizationId: z.string().uuid(), roleId: z.string().uuid(), permissionKey: z.string().min(1).max(100), scope: z.enum(SCOPES) });
const removeSchema = z.object({ organizationId: z.string().uuid(), roleId: z.string().uuid(), permissionKey: z.string().min(1).max(100) });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Step 16/21: per-
 * permission editing for an ordinary (non-protected) organization role. ROLE_PERMISSION_CHANGED is
 * one of the six mandatory-audited mutations — atomic with its own write via `OrganizationAuditedMutations`,
 * which validates the permission key against the canonical catalog, rejects unsupported scopes, and
 * refuses to edit a protected role's permissions — never duplicated here. Gated on `roles.edit`;
 * permission changes take effect immediately in the next `OrganizationPermissionService.can` call
 * (no caching, no stale legacy-capability fallback).
 */
export function createRolePermissionsPostHandler(authService: AuthService, permissions: OrganizationPermissionService, mutations: OrganizationAuditedMutations) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = assignSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId, roleId, permissionKey, and scope are required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.edit");
    await mutations.changeRolePermission({
      organizationId: parsed.data.organizationId,
      actorUserId: userId,
      roleId: parsed.data.roleId,
      permissionKey: parsed.data.permissionKey,
      scope: parsed.data.scope,
      grant: true,
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

export function createRolePermissionsDeleteHandler(authService: AuthService, permissions: OrganizationPermissionService, mutations: OrganizationAuditedMutations) {
  return async function handleDelete(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = removeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId, roleId, and permissionKey are required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.edit");
    await mutations.changeRolePermission({
      organizationId: parsed.data.organizationId,
      actorUserId: userId,
      roleId: parsed.data.roleId,
      permissionKey: parsed.data.permissionKey,
      scope: "organization",
      grant: false,
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRolePermissionsPostHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationAuditedMutations())(request);
}
async function handleDelete(request: NextRequest): Promise<Response> {
  return createRolePermissionsDeleteHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationAuditedMutations())(request);
}

export const POST = withErrorHandling("organizations_role_permissions_post", handlePost);
export const DELETE = withErrorHandling("organizations_role_permissions_delete", handleDelete);
