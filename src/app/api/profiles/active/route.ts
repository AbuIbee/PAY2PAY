import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getActiveProfileSelectorFromCookie, setActiveProfileCookie } from "@/lib/profiles/activeProfileCookie";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("business"), businessProfileId: z.string().uuid() }),
]);

/**
 * Re-verifies the cookie-hinted selection on every read (see
 * activeProfileCookie.ts's doc comment) rather than trusting it — falls
 * back to the personal profile if there is no cookie or it no longer
 * resolves (e.g. the business was disabled since the cookie was set).
 */
export function createActiveProfileGetHandler(authService: AuthService, profileAccess: ProfileAccessService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const cookieSelector = getActiveProfileSelectorFromCookie(request);
    try {
      const resolved = await profileAccess.resolveActiveProfile(userId, cookieSelector ?? { kind: "personal" });
      return NextResponse.json(resolved, { status: 200 });
    } catch {
      const fallback = await profileAccess.resolveActiveProfile(userId, { kind: "personal" });
      return NextResponse.json(fallback, { status: 200 });
    }
  };
}

export function createActiveProfileSetHandler(authService: AuthService, profileAccess: ProfileAccessService) {
  return async function handleSet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = selectorSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A valid profile selection is required.");
    }
    // Ownership/status re-verified here — never trusts the browser-supplied id directly.
    const resolved = await profileAccess.resolveActiveProfile(userId, parsed.data);
    const response = NextResponse.json(resolved, { status: 200 });
    setActiveProfileCookie(response, parsed.data);
    return response;
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createActiveProfileGetHandler(getAuthService(), getProfileAccessService())(request);
}

async function handleSet(request: NextRequest): Promise<Response> {
  return createActiveProfileSetHandler(getAuthService(), getProfileAccessService())(request);
}

export const GET = withErrorHandling("profiles_active_get", handleGet);
export const POST = withErrorHandling("profiles_active_set", handleSet);
