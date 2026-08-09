import type { NextRequest } from "next/server";
import { AuthenticationError } from "@/lib/errors";
import type { AuthService } from "./authService";
import { getSessionToken } from "./cookies";

/**
 * Shared "protected route" seam — validates the session cookie and returns
 * the caller's identity plus session id (needed by MFA step-up, which is
 * scoped per-session). Throws AuthenticationError (401) if there is no
 * valid session, so every caller gets identical unauthorized behavior
 * instead of each route re-deriving it (previously only inlined in
 * src/app/api/auth/me/route.ts).
 */
export async function requireSession(
  request: NextRequest,
  authService: AuthService,
): Promise<{ userId: string; email: string; sessionId: string }> {
  const token = getSessionToken(request);
  const validated = token ? await authService.validateSession(token) : null;
  if (!validated) {
    throw new AuthenticationError("A valid session is required.");
  }
  return { userId: validated.user.id, email: validated.user.email, sessionId: validated.sessionId };
}
