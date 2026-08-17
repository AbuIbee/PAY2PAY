import { NextResponse, type NextRequest } from "next/server";
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

/** PRSprint 11B: GET /api/admin/businesses/detail?id=... — mirrors GET /api/admin/users/detail. */
export function createAdminBusinessDetailHandler(authService: AuthService, adminService: AdminService) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const targetBusinessId = new URL(request.url).searchParams.get("id");
    if (!targetBusinessId) throw new ValidationError("id is required.");

    const detail = await adminService.getBusinessDetail(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      targetBusinessId,
    );
    return NextResponse.json(detail, { status: 200 });
  };
}

async function handleDetail(request: NextRequest): Promise<Response> {
  return createAdminBusinessDetailHandler(getAuthService(), getAdminService())(request);
}

export const GET = withErrorHandling("admin_business_detail", handleDetail);
