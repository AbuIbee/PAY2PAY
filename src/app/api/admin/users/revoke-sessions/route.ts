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

const revokeSchema = z.object({ targetUserId: z.string().uuid(), reason: z.string().trim().max(2000).optional() });

export function createAdminRevokeSessionsHandler(authService: AuthService, adminService: AdminService) {
  return async function handleRevoke(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revokeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("targetUserId is required.");
    await adminService.revokeUserSessions(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.targetUserId,
      parsed.data.reason ?? null,
    );
    return NextResponse.json({ status: "sessions_revoked" }, { status: 200 });
  };
}

async function handleRevoke(request: NextRequest): Promise<Response> {
  return createAdminRevokeSessionsHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_revoke_sessions", handleRevoke);
