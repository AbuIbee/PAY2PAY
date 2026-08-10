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

const endSchema = z.object({ impersonationSessionId: z.string().uuid() });

export function createAdminImpersonationEndHandler(authService: AuthService, adminService: AdminService) {
  return async function handleEnd(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = endSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("impersonationSessionId is required.");
    await adminService.endImpersonation(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.impersonationSessionId,
    );
    return NextResponse.json({ status: "ended" }, { status: 200 });
  };
}

async function handleEnd(request: NextRequest): Promise<Response> {
  return createAdminImpersonationEndHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_impersonation_end", handleEnd);
