import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const revokeSchema = z.object({ sessionId: z.string().uuid() });

/**
 * PRSprint 06: revokes exactly one of the caller's own sessions ("Signed-in devices" -> Revoke).
 * AuthService.revokeSession independently re-checks ownership (never trusts that a session id
 * belongs to the caller just because they sent it) — this route only supplies identity + input,
 * matching the rest of this codebase's "service re-checks, route never gates alone" pattern.
 */
export function createRevokeSessionHandler(authService: AuthService) {
  return async function handleRevokeSession(request: NextRequest): Promise<Response> {
    const { userId, sessionId: currentSessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revokeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("sessionId is required.");

    await authService.revokeSession(userId, parsed.data.sessionId, {
      ipAddress: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ status: "session_revoked" }, { status: 200 });
    // Revoking the session that authenticated this very request must also clear its cookie —
    // otherwise the browser would keep sending a token the server has already invalidated.
    if (parsed.data.sessionId === currentSessionId) {
      clearSessionCookie(response);
    }
    return response;
  };
}

async function handleRevokeSession(request: NextRequest): Promise<Response> {
  return createRevokeSessionHandler(getAuthService())(request);
}

export const POST = withErrorHandling("account_sessions_revoke", handleRevokeSession);
