import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { DrizzleStaffInvitationRepository } from "@/lib/staff/drizzleStaffInvitationRepository";
import type { StaffInvitationRepository } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ organizationId: z.string().uuid(), invitationId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 12: revoke a pending
 * invitation. Gated on `members.invite` (the same permission that creates invitations). Tenant-scoped:
 * an invitationId belonging to a different organization is rejected, never revoked.
 */
export function createInvitationsRevokeHandler(authService: AuthService, permissions: OrganizationPermissionService, invitations: StaffInvitationRepository) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId and invitationId are required.");

    await permissions.require(userId, parsed.data.organizationId, "members.invite");

    const pending = await invitations.listPendingForBusiness(parsed.data.organizationId);
    const invitation = pending.find((i) => i.id === parsed.data.invitationId);
    if (!invitation) throw new ValidationError("This invitation does not belong to this organization, or is no longer pending.");

    await invitations.revoke(invitation.id, new Date());
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createInvitationsRevokeHandler(getAuthService(), getOrganizationPermissionService(), new DrizzleStaffInvitationRepository())(request);
}

export const POST = withErrorHandling("organizations_invitations_revoke", handlePost);
