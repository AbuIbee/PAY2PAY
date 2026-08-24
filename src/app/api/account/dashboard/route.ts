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
 * Minimal protected dashboard data (Sprint 2's "Basic Account Dashboard" UI
 * requirement) — also the route the "unauthorized user cannot access
 * protected dashboard data" test targets.
 */
export function createDashboardHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    const { userId, email } = await requireSession(request, authService);
    const mfaEnrolled = await mfaService.hasVerifiedMethod(userId);
    // Section K (closed-beta remediation): the account settings page's own display of the
    // user-facing "P2P-XXXXXXXX" reference, generated lazily for a pre-existing row that has none.
    const publicReference = await authService.ensurePublicReference(userId);
    return NextResponse.json({ email, mfaEnrolled, publicReference }, { status: 200 });
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createDashboardHandler(getAuthService(), getMfaService())(request);
}

export const GET = withErrorHandling("account_dashboard", handleDashboard);
