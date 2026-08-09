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

const updateRoleSchema = z.object({
  businessProfileId: z.string().uuid(),
  targetStaffId: z.string().uuid(),
  newRole: z.enum(["owner", "manager", "receivables_staff", "accountant_viewer", "custom"]),
  newCustomRoleId: z.string().uuid().optional(),
});

/**
 * Role changes always require a fresh step-up (StaffService.updateStaffRole)
 * — the client must have already completed
 * /api/auth/mfa/step-up/verify for this session. Self-promotion and
 * granting "owner" without already being an owner are both rejected inside
 * the service, not here.
 */
export function createStaffUpdateRoleHandler(authService: AuthService, staffService: StaffService) {
  return async function handleUpdateRole(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = updateRoleSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid role change is required.");
    }

    await staffService.updateStaffRole({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      actingSessionId: sessionId,
      targetStaffId: parsed.data.targetStaffId,
      newRole: parsed.data.newRole,
      newCustomRoleId: parsed.data.newCustomRoleId ?? null,
    });
    return NextResponse.json({ status: "updated" }, { status: 200 });
  };
}

async function handleUpdateRole(request: NextRequest): Promise<Response> {
  return createStaffUpdateRoleHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_update_role", handleUpdateRole);
