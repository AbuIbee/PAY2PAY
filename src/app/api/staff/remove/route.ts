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

const removeSchema = z.object({
  businessProfileId: z.string().uuid(),
  targetStaffId: z.string().uuid(),
});

/**
 * A removal that affects a high-risk capability (manage_staff,
 * approve_settlement, forgive_principal, change_payout_configuration,
 * approve_high_value_action) requires a fresh step-up — see
 * StaffService.removeStaff. The client is expected to have already
 * completed /api/auth/mfa/step-up/verify for this session before calling
 * this route when removing a high-privilege staff member.
 */
export function createStaffRemoveHandler(authService: AuthService, staffService: StaffService) {
  return async function handleRemove(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = removeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("businessProfileId and targetStaffId are required.");

    await staffService.removeStaff({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      actingSessionId: sessionId,
      targetStaffId: parsed.data.targetStaffId,
    });
    return NextResponse.json({ status: "removed" }, { status: 200 });
  };
}

async function handleRemove(request: NextRequest): Promise<Response> {
  return createStaffRemoveHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_remove", handleRemove);
