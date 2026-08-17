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

const reactivateSchema = z.object({ targetBusinessId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) });

/** PRSprint 11B: mirrors /api/admin/users/reactivate for a business_profile target. */
export function createAdminReactivateBusinessHandler(authService: AuthService, adminService: AdminService) {
  return async function handleReactivate(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = reactivateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "targetBusinessId and a reason are required.");
    }
    await adminService.reactivateBusiness(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.targetBusinessId,
      parsed.data.reason,
    );
    return NextResponse.json({ status: "active" }, { status: 200 });
  };
}

async function handleReactivate(request: NextRequest): Promise<Response> {
  return createAdminReactivateBusinessHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_business_reactivate", handleReactivate);
