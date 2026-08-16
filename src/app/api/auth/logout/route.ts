import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { clearSessionCookie, getSessionToken } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { AuthenticationError } from "@/lib/errors";
import { ACTIVE_PROFILE_COOKIE_NAME } from "@/lib/profiles/activeProfileCookie";

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
    // PRSprint 10A: the active-profile cookie is never a trust boundary on its own (every read is
    // re-verified against the caller's own session — see activeProfileCookie.ts's doc comment), so
    // this was already safe without this line. Clearing it anyway removes any residual business-
    // context hint from the browser the moment the session that hint belonged to ends.
    response.cookies.set(ACTIVE_PROFILE_COOKIE_NAME, "", { path: "/", expires: new Date(0) });
    return response;
  };
}

async function handleLogout(request: NextRequest): Promise<Response> {
  return createLogoutHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_logout", handleLogout);
