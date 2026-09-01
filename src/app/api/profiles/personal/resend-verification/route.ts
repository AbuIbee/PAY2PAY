import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { PersonalProfileService } from "@/lib/profiles/personalProfileService";
import { getPersonalProfileService } from "@/lib/profiles/getPersonalProfileService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createPersonalProfileResendVerificationHandler(authService: AuthService, personalProfileService: PersonalProfileService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    await personalProfileService.resendPreferredEmailVerification(userId);
    return NextResponse.json({ sent: true }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPersonalProfileResendVerificationHandler(getAuthService(), getPersonalProfileService())(request);
}

export const POST = withErrorHandling("personal_profile_resend_verification", handlePost);
