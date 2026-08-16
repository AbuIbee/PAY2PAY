import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): "Device/session
 * visibility" — the self-service counterpart to the admin-only POST
 * /api/admin/users/revoke-sessions. Never returns sessionTokenHash (that would let a client
 * reconstruct a way to compare/guess tokens) — only display fields plus which entry is the
 * session making this very request.
 */
export function createListSessionsHandler(authService: AuthService) {
  return async function handleListSessions(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const sessions = await authService.listSessions(userId);
    return NextResponse.json(
      {
        sessions: sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          isCurrent: session.id === sessionId,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleListSessions(request: NextRequest): Promise<Response> {
  return createListSessionsHandler(getAuthService())(request);
}

export const GET = withErrorHandling("account_sessions_list", handleListSessions);
