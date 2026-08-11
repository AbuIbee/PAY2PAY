import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import type { B2BDashboardReader } from "@/lib/b2b/b2bDashboardReader";
import { getB2BDashboardReader } from "@/lib/b2b/getB2BDashboardReader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) business financial dashboard —
 * deliberately a new, separate route rather than an extension of Sprint 3's
 * `/api/dashboard/business` (whose route.test.ts asserts an exact-match empty-state response body;
 * adding fields there would break that assertion for no real benefit). Same ownership-verification
 * discipline as that route: never trusts the `businessProfileId` query param directly.
 */
export function createB2BDashboardHandler(authService: AuthService, profileAccess: ProfileAccessService, dashboard: B2BDashboardReader) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) {
      throw new ValidationError("businessProfileId is required.");
    }
    await profileAccess.resolveActiveProfile(userId, { kind: "business", businessProfileId });

    const data = await dashboard.getDashboard(businessProfileId);
    return NextResponse.json(data, { status: 200 });
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createB2BDashboardHandler(getAuthService(), getProfileAccessService(), getB2BDashboardReader())(request);
}

export const GET = withErrorHandling("b2b_dashboard", handleDashboard);
