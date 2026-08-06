import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getSessionToken } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { AuthenticationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal protected-route example: returns the caller's own identity if
 * (and only if) they present a valid, unexpired, unrevoked session — the
 * pattern every later protected route follows via
 * AuthService.validateSession.
 */
export function createMeHandler(authService: AuthService) {
  return async function handleMe(request: NextRequest): Promise<Response> {
    const token = getSessionToken(request);
    const validated = token ? await authService.validateSession(token) : null;
    if (!validated) {
      throw new AuthenticationError("A valid session is required.");
    }
    return NextResponse.json({ id: validated.user.id, email: validated.user.email }, { status: 200 });
  };
}

async function handleMe(request: NextRequest): Promise<Response> {
  return createMeHandler(getAuthService())(request);
}

export const GET = withErrorHandling("auth_me", handleMe);
