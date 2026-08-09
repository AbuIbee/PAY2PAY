import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every profile (personal + active businesses) the caller may select — for the switcher UI. */
export function createProfilesListHandler(authService: AuthService, profileAccess: ProfileAccessService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const profiles = await profileAccess.listSelectableProfiles(userId);
    return NextResponse.json({ profiles }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createProfilesListHandler(getAuthService(), getProfileAccessService())(request);
}

export const GET = withErrorHandling("profiles_list", handleList);
