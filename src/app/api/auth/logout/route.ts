import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { clearSessionCookie, getSessionToken } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { AuthenticationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createLogoutHandler(authService: AuthService) {
  return async function handleLogout(request: NextRequest): Promise<Response> {
    const token = getSessionToken(request);
    if (!token) {
      throw new AuthenticationError("No active session.");
    }

    await authService.logout(token);

    const response = NextResponse.json({ status: "ok" }, { status: 200 });
    clearSessionCookie(response);
    return response;
  };
}

async function handleLogout(request: NextRequest): Promise<Response> {
  return createLogoutHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_logout", handleLogout);
