import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { isAdminRole } from "@/lib/admin/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight check the UI uses to decide whether to show admin navigation at all — never the actual authorization boundary (every /api/admin/* route re-checks independently). */
export function createAdminWhoAmIHandler(authService: AuthService) {
  return async function handleWhoAmI(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    return NextResponse.json({ platformRole, isAdmin: isAdminRole(platformRole) }, { status: 200 });
  };
}

async function handleWhoAmI(request: NextRequest): Promise<Response> {
  return createAdminWhoAmIHandler(getAuthService())(request);
}

export const GET = withErrorHandling("admin_whoami", handleWhoAmI);
