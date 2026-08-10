import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roleSchema = z.object({
  targetUserId: z.string().uuid(),
  newRole: z.enum(["member", "platform_admin"]),
  reason: z.string().trim().min(1).max(2000),
});

/** Owner-only — AdminService.changeUserRole itself enforces this; the route does not duplicate the check. */
export function createAdminChangeRoleHandler(authService: AuthService, adminService: AdminService) {
  return async function handleRole(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = roleSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid targetUserId, newRole, and reason are required.");
    }
    await adminService.changeUserRole(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.targetUserId,
      parsed.data.newRole,
      parsed.data.reason,
    );
    return NextResponse.json({ status: "role_changed" }, { status: 200 });
  };
}

async function handleRole(request: NextRequest): Promise<Response> {
  return createAdminChangeRoleHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_change_role", handleRole);
