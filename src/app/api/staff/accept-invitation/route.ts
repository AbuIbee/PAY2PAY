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

const acceptSchema = z.object({ token: z.string().min(1) });

export function createStaffAcceptInvitationHandler(authService: AuthService, staffService: StaffService) {
  return async function handleAccept(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = acceptSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid invitation token is required.");

    const member = await staffService.acceptInvitation(parsed.data.token, userId);
    return NextResponse.json(
      { id: member.id, businessProfileId: member.businessProfileId, role: member.role },
      { status: 200 },
    );
  };
}

async function handleAccept(request: NextRequest): Promise<Response> {
  return createStaffAcceptInvitationHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_accept_invitation", handleAccept);
