import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05-style bound, mirroring /api/admin/users/suspend's own rate limit.
const SUSPEND_LIMIT_PER_ADMIN = 60;
const SUSPEND_WINDOW_MS = 60 * 60 * 1000;

const suspendSchema = z.object({ targetBusinessId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) });

/** PRSprint 11B: mirrors /api/admin/users/suspend for a business_profile target. */
export function createAdminSuspendBusinessHandler(authService: AuthService, adminService: AdminService) {
  return async function handleSuspend(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = suspendSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "targetBusinessId and a reason are required.");
    }
    if (!(await checkRateLimit(`admin-business-suspend:admin:${userId}`, SUSPEND_LIMIT_PER_ADMIN, SUSPEND_WINDOW_MS))) {
      throw new RateLimitedError("Too many suspend actions. Please try again later.");
    }
    await adminService.suspendBusiness(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.targetBusinessId,
      parsed.data.reason,
    );
    return NextResponse.json({ status: "suspended" }, { status: 200 });
  };
}

async function handleSuspend(request: NextRequest): Promise<Response> {
  return createAdminSuspendBusinessHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_business_suspend", handleSuspend);
