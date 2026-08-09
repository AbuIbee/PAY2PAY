import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { getMfaService } from "@/lib/auth/getMfaService";
import type { MfaService } from "@/lib/auth/mfaService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createTotpEnrollHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleEnroll(request: NextRequest): Promise<Response> {
    const { userId, email } = await requireSession(request, authService);
    const { secret, otpauthUri } = await mfaService.beginTotpEnrollment(userId, email);
    return NextResponse.json({ secret, otpauthUri }, { status: 200 });
  };
}

async function handleEnroll(request: NextRequest): Promise<Response> {
  return createTotpEnrollHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_totp_enroll", handleEnroll);
