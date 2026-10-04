import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DrizzleOrganizationRoleRepository } from "@/lib/organizations/drizzleOrganizationRoleRepository";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationRoleRepository } from "@/lib/organizations/organizationRoleRepository";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { DrizzleUserEmailReader } from "@/lib/staff/drizzleUserEmailReader";
import type { BusinessStaffMemberRepository, UserEmailReader } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ organizationId: z.string().uuid() });

/** Display-only label for the legacy StaffRole enum — never used for any authorization decision. */
function legacyRoleLabel(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 11/20: the Business
 * nav's "Employees" -> Team Members tab own real data source. Fails closed on the canonical
 * `OrganizationPermissionService` ("members.view") — never `canReadOrganizationResource`. Role is
 * shown by its real `organization_role.displayName` when the membership has been migrated/assigned
 * one, falling back to a plain legacy-enum DISPLAY label otherwise — role NAME is never consulted for
 * authorization anywhere in this route; it is rendered for humans only.
 */
export function createOrganizationEmployeesGetHandler(
  authService: AuthService,
  permissions: OrganizationPermissionService,
  staffMembers: BusinessStaffMemberRepository,
  emailReader: UserEmailReader,
  roles: OrganizationRoleRepository,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    const allowed = await permissions.can(userId, parsed.data.organizationId, "members.view");
    if (!allowed) throw new ForbiddenError("You do not have access to this organization's team members.");

    const members = await staffMembers.listActiveByBusiness(parsed.data.organizationId);
    const items = await Promise.all(
      members.map(async (m) => {
        const role = m.roleId ? await roles.findRoleForOrganization(parsed.data.organizationId, m.roleId) : null;
        return {
          id: m.id,
          userId: m.userId,
          email: await emailReader.getEmailByUserId(m.userId),
          roleId: role?.id ?? null,
          roleName: role?.displayName ?? legacyRoleLabel(m.role),
          isOwnerRole: role?.isOwnerRole ?? m.role === "OWNER",
          isAuthorizedRepresentative: m.isAuthorizedRepresentative,
          memberSince: m.createdAt,
        };
      }),
    );
    return NextResponse.json({ items }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationEmployeesGetHandler(
    getAuthService(),
    getOrganizationPermissionService(),
    new DrizzleBusinessStaffMemberRepository(),
    new DrizzleUserEmailReader(),
    new DrizzleOrganizationRoleRepository(),
  )(request);
}

export const GET = withErrorHandling("organizations_employees_get", handleGet);
