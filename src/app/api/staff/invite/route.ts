import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inviteSchema = z.object({
  businessProfileId: z.string().uuid(),
  email: z.string().trim().email(),
  role: z.enum(["owner", "manager", "receivables_staff", "accountant_viewer", "custom"]),
  customRoleId: z.string().uuid().optional(),
});

export function createStaffInviteHandler(authService: AuthService, staffService: StaffService) {
  return async function handleInvite(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = inviteSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid invitation is required.");
    }

    const invitation = await staffService.inviteStaff({
      businessProfileId: parsed.data.businessProfileId,
      invitedByUserId: userId,
      email: parsed.data.email,
      role: parsed.data.role,
      customRoleId: parsed.data.customRoleId ?? null,
    });
    return NextResponse.json(
      { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt },
      { status: 201 },
    );
  };
}

async function handleInvite(request: NextRequest): Promise<Response> {
  return createStaffInviteHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_invite", handleInvite);
