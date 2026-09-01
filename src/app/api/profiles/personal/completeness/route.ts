import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { PersonalProfileService } from "@/lib/profiles/personalProfileService";
import { getPersonalProfileService } from "@/lib/profiles/getPersonalProfileService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Corrected per explicit review: "before a personal user can COMPLETE their agreement
 * participation... require ALL of" the full profile (first/last name, contact phone, verified
 * preferred email, and full address — line 2 excepted) — identical to `checkProfileCompleteness`'s
 * own required-field list. Used by the agreement UI to decide whether to show "Complete your profile
 * to continue" before letting a personal user accept/sign.
 */
export function createPersonalProfileCompletenessHandler(authService: AuthService, personalProfileService: PersonalProfileService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const result = await personalProfileService.checkAgreementParticipationReadiness(userId);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createPersonalProfileCompletenessHandler(getAuthService(), getPersonalProfileService())(request);
}

export const GET = withErrorHandling("personal_profile_completeness", handleGet);
