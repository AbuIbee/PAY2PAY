import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { getMfaService } from "@/lib/auth/getMfaService";
import type { MfaService } from "@/lib/auth/mfaService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin read-only route over MfaService.listEnrolledMethods — the
 * enrollment page and the shared <StepUpChallenge> both need to know which
 * methods (if any) are already verified before rendering, so a step-up
 * challenge is never shown to a user who has no way to complete it.
 */
export function createMfaStatusHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleStatus(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const methods = await mfaService.listEnrolledMethods(userId);
    return NextResponse.json({ enrolled: methods.length > 0, methods }, { status: 200 });
  };
}

async function handleStatus(request: NextRequest): Promise<Response> {
  return createMfaStatusHandler(getAuthService(), getMfaService())(request);
}

export const GET = withErrorHandling("auth_mfa_status", handleStatus);
