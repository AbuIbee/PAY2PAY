import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { isAdminRole } from "@/lib/admin/capabilities";
import { runDeepHealthCheck } from "@/lib/admin/deepHealthCheck";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health — PRSprint 28's admin-only deep health check (database reachability +
 * environment-configuration validity). Never returns a secret value or raw driver error — see
 * deepHealthCheck.ts's own doc comment.
 */
export function createAdminHealthHandler(authService: AuthService) {
  return async function handleHealth(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    if (!isAdminRole(platformRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    const report = await runDeepHealthCheck();
    const overallOk = report.database === "ok" && report.environmentConfiguration === "ok";
    return NextResponse.json(report, { status: overallOk ? 200 : 503 });
  };
}

async function handleHealth(request: NextRequest): Promise<Response> {
  return createAdminHealthHandler(getAuthService())(request);
}

export const GET = withErrorHandling("admin_health_check", handleHealth);
