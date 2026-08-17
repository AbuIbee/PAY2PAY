import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): lets the
 * UI re-surface an admin's own still-open support view after a page refresh or navigation elsewhere
 * — see AdminImpersonationSessionRepository.findActiveForAdmin's doc comment for why this exists.
 * Same 401/403 shape as every other /api/admin/* route (AdminService.getActiveImpersonation
 * re-checks actingRole itself); returns `{ active: null }` on 200 when the caller is an admin with
 * no currently-open support view.
 */
export function createAdminImpersonationActiveHandler(authService: AuthService, adminService: AdminService) {
  return async function handleActive(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const active = await adminService.getActiveImpersonation({
      actingUserId: userId,
      actingSessionId: sessionId,
      actingRole: platformRole,
      ipAddress: getClientIp(request),
      deviceInfo: null,
    });
    return NextResponse.json({ active }, { status: 200 });
  };
}

async function handleActive(request: NextRequest): Promise<Response> {
  return createAdminImpersonationActiveHandler(getAuthService(), getAdminService())(request);
}

export const GET = withErrorHandling("admin_impersonation_active", handleActive);
