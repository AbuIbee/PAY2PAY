import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 3's business dashboard. Ownership is re-verified through
 * ProfileAccessService (never trusts the `businessProfileId` query param
 * directly) before returning anything — same discipline as
 * /api/profiles/active. "No fake financial data": every value is honestly
 * zero/empty since no agreement/customer table exists yet.
 */
export function createBusinessDashboardHandler(authService: AuthService, profileAccess: ProfileAccessService) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) {
      throw new ValidationError("businessProfileId is required.");
    }
    // Throws ForbiddenError/ValidationError if not owned or not active — see profileAccessService.ts.
    await profileAccess.resolveActiveProfile(userId, { kind: "business", businessProfileId });

    return NextResponse.json(
      {
        receivablesMinorUnits: 0,
        payablesMinorUnits: 0,
        agreements: [],
        customers: [],
        staffPlaceholder: true, // Sprint 4's scope
        reportsPlaceholder: true, // later sprint's scope
      },
      { status: 200 },
    );
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createBusinessDashboardHandler(getAuthService(), getProfileAccessService())(request);
}

export const GET = withErrorHandling("dashboard_business", handleDashboard);
