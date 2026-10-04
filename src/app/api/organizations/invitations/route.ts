import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { generateOpaqueToken, hashOpaqueToken } from "@/lib/auth/token";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getServerEnv } from "@/config/env";
import { ValidationError } from "@/lib/errors";
import { getEmailSender } from "@/lib/notify/getEmailSender";
import { DrizzleOrganizationRoleRepository } from "@/lib/organizations/drizzleOrganizationRoleRepository";
import { getOrganizationAuditedMutations } from "@/lib/organizations/getOrganizationAuditedMutations";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutations";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import type { OrganizationRoleRepository } from "@/lib/organizations/organizationRoleRepository";
import { DrizzleStaffInvitationRepository } from "@/lib/staff/drizzleStaffInvitationRepository";
import type { StaffInvitationRepository } from "@/lib/staff/staffService";
import type { EmailSender } from "@/lib/notify/emailSender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const listQuerySchema = z.object({ organizationId: z.string().uuid() });
const createSchema = z.object({ organizationId: z.string().uuid(), email: z.string().trim().email(), roleId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Step 12/21: the
 * Invitations tab's own real data source and creation route — organization_role-based (`roleId`),
 * never the legacy `StaffService.inviteStaff` flow (which the still-disabled `/organization/staff`
 * page used). MEMBER_INVITED is one of the six mandatory-audited mutations — the invitation row and
 * its audit event commit atomically via `OrganizationAuditedMutations`; email delivery happens AFTER
 * that commit succeeds (a delivery failure must never roll back an already-committed invitation, and a
 * rolled-back invitation must never have already sent an email). The legacy `role` enum column (NOT
 * NULL) is set to "VIEWER" as an inert placeholder — real authorization for the resulting membership
 * runs exclusively on `roleId` from this flow forward (see `StaffService.acceptInvitation`'s own doc
 * comment on copying `invitation.roleId` onto the new membership). Acceptance reuses the existing
 * `/staff/accept-invitation` page/flow unchanged.
 */
export function createInvitationsGetHandler(authService: AuthService, permissions: OrganizationPermissionService, invitations: StaffInvitationRepository) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    await permissions.require(userId, parsed.data.organizationId, "members.view");
    const pending = await invitations.listPendingForBusiness(parsed.data.organizationId);
    return NextResponse.json(
      { items: pending.map((i) => ({ id: i.id, email: i.email, roleId: i.roleId, expiresAt: i.expiresAt, createdAt: i.createdAt })) },
      { status: 200 },
    );
  };
}

export function createInvitationsPostHandler(
  authService: AuthService,
  permissions: OrganizationPermissionService,
  mutations: OrganizationAuditedMutations,
  roles: OrganizationRoleRepository,
  emailSender: EmailSender,
  appUrl: string,
) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid organizationId, email, and roleId are required.");

    await permissions.require(userId, parsed.data.organizationId, "members.invite");

    // Tenant-scoped lookup, for the email body's role name only — `mutations.inviteMember` re-validates
    // the SAME tenant-scoping itself before writing, so a stale/raced read here can never admit a
    // cross-tenant role into the actual invitation row.
    const role = await roles.findRoleForOrganization(parsed.data.organizationId, parsed.data.roleId);
    if (!role) throw new ValidationError("This role does not belong to this organization.");

    const email = normalizeEmail(parsed.data.email);
    const rawToken = generateOpaqueToken();
    const invitation = await mutations.inviteMember({
      organizationId: parsed.data.organizationId,
      actorUserId: userId,
      email,
      roleId: parsed.data.roleId,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });

    // Delivery happens only AFTER the invitation + its audit event have already committed — a failed
    // send never rolls back an already-persisted invitation, and a rolled-back (failed) invitation
    // attempt never reaches this line at all.
    const link = `${appUrl}/staff/accept-invitation?token=${rawToken}`;
    await emailSender.send({
      to: email,
      subject: "You've been invited to join a Paid2You Business team",
      body: `You've been invited to join a business team on Paid2You as ${role.displayName}. Accept the invitation: ${link}\n\nThis link expires in 7 days.`,
    });

    return NextResponse.json({ id: invitation.id, email: invitation.email, roleId: invitation.roleId }, { status: 201 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createInvitationsGetHandler(getAuthService(), getOrganizationPermissionService(), new DrizzleStaffInvitationRepository())(request);
}

async function handlePost(request: NextRequest): Promise<Response> {
  const { APP_URL } = getServerEnv();
  return createInvitationsPostHandler(
    getAuthService(),
    getOrganizationPermissionService(),
    getOrganizationAuditedMutations(),
    new DrizzleOrganizationRoleRepository(),
    getEmailSender(),
    APP_URL,
  )(request);
}

export const GET = withErrorHandling("organizations_invitations_get", handleGet);
export const POST = withErrorHandling("organizations_invitations_post", handlePost);
