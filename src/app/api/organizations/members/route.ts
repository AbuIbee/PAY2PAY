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

const changeRoleSchema = z.object({ organizationId: z.string().uuid(), memberId: z.string().uuid(), roleId: z.string().uuid() });
const removeSchema = z.object({ organizationId: z.string().uuid(), memberId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Step 11/17/18/21: the
 * Team Members tab's own mutation routes. MEMBER_ROLE_CHANGED/MEMBER_REMOVED are two of the six
 * mandatory-audited mutations — gated on the canonical `OrganizationPermissionService`
 * (`roles.assign`/`members.remove`) and then committed atomically with their audit event via
 * `OrganizationAuditedMutations`, which re-validates tenant ownership and last-Owner protection
 * server-side. Never trusts the client's claim that a role_id belongs to this organization.
 */
export function createMembersPatchHandler(authService: AuthService, permissions: OrganizationPermissionService, mutations: OrganizationAuditedMutations) {
  return async function handlePatch(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = changeRoleSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId, memberId, and roleId are required.");

    await permissions.require(userId, parsed.data.organizationId, "roles.assign");
    await mutations.changeMemberRole({ organizationId: parsed.data.organizationId, actorUserId: userId, targetMembershipId: parsed.data.memberId, newRoleId: parsed.data.roleId });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

export function createMembersDeleteHandler(authService: AuthService, permissions: OrganizationPermissionService, mutations: OrganizationAuditedMutations) {
  return async function handleDelete(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = removeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId and memberId are required.");

    await permissions.require(userId, parsed.data.organizationId, "members.remove");
    await mutations.removeMember({ organizationId: parsed.data.organizationId, actorUserId: userId, targetMembershipId: parsed.data.memberId });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handlePatch(request: NextRequest): Promise<Response> {
  return createMembersPatchHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationAuditedMutations())(request);
}

async function handleDelete(request: NextRequest): Promise<Response> {
  return createMembersDeleteHandler(getAuthService(), getOrganizationPermissionService(), getOrganizationAuditedMutations())(request);
}

export const PATCH = withErrorHandling("organizations_members_patch", handlePatch);
export const DELETE = withErrorHandling("organizations_members_delete", handleDelete);
