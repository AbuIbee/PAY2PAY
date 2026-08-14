import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getActiveProfileSelectorFromCookie } from "@/lib/profiles/activeProfileCookie";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import type { VerificationService } from "@/lib/profiles/verificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin read/write route over VerificationService for the
 * caller's own *active* profile (never another profile — mirrors
 * /api/profiles/active's own cookie-verification pattern). No route
 * exposed this before; the manual-decision (reviewer) side stays
 * unexposed here (VerificationService.recordManualVerificationDecision's
 * own doc comment: that's an admin-surface concern, not this one).
 */
export function createVerificationGetHandler(authService: AuthService, profileAccess: ProfileAccessService, verification: VerificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const cookieSelector = getActiveProfileSelectorFromCookie(request);
    const active = await profileAccess.resolveActiveProfile(userId, cookieSelector ?? { kind: "personal" });
    const profileId = active.kind === "personal" ? active.personalProfileId! : active.businessProfileId!;
    const state = await verification.getVerificationState(active.kind, profileId);
    return NextResponse.json({ profileKind: active.kind, state }, { status: 200 });
  };
}

export function createVerificationSubmitHandler(authService: AuthService, profileAccess: ProfileAccessService, verification: VerificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const cookieSelector = getActiveProfileSelectorFromCookie(request);
    const active = await profileAccess.resolveActiveProfile(userId, cookieSelector ?? { kind: "personal" });
    const profileId = active.kind === "personal" ? active.personalProfileId! : active.businessProfileId!;
    const record = await verification.submitFullVerificationRequest(active.kind, profileId);
    return NextResponse.json({ record }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createVerificationGetHandler(getAuthService(), getProfileAccessService(), getVerificationService())(request);
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createVerificationSubmitHandler(getAuthService(), getProfileAccessService(), getVerificationService())(request);
}

export const GET = withErrorHandling("profiles_verification_get", handleGet);
export const POST = withErrorHandling("profiles_verification_submit", handlePost);
