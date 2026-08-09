import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 3's personal dashboard: "No fake financial data. Empty state
 * values must reflect actual stored data." No agreement/payment/request
 * tables exist yet (Sprint 5+/9+/16+), so every value here is honestly
 * zero/empty rather than a placeholder number — there is nothing to sum yet.
 */
export function createPersonalDashboardHandler(authService: AuthService) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    await requireSession(request, authService);
    return NextResponse.json(
      {
        moneyIOweMinorUnits: 0,
        moneyOwedToMeMinorUnits: 0,
        agreements: [],
        upcomingPayments: [],
        requests: [],
      },
      { status: 200 },
    );
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createPersonalDashboardHandler(getAuthService())(request);
}

export const GET = withErrorHandling("dashboard_personal", handleDashboard);
