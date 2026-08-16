import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): "log out
 * everywhere" — revokes every session for the caller, including the one this very request used,
 * so the cookie is always cleared too (unlike POST /api/account/sessions/revoke, where the target
 * session may or may not be the current one).
 */
export function createLogoutAllHandler(authService: AuthService) {
  return async function handleLogoutAll(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    await authService.revokeAllSessions(userId, {
      ipAddress: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    const response = NextResponse.json({ status: "logged_out_everywhere" }, { status: 200 });
    clearSessionCookie(response);
    return response;
  };
}

async function handleLogoutAll(request: NextRequest): Promise<Response> {
  return createLogoutAllHandler(getAuthService())(request);
}

export const POST = withErrorHandling("account_sessions_logout_all", handleLogoutAll);
