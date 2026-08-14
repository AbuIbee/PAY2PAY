import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AppealService } from "@/lib/admin/appealService";
import { getAppealService } from "@/lib/admin/getAppealService";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/appeals?id=... — a single appeal by id; GET /api/admin/appeals (no query) — every
 * still-open appeal (requires "manage_appeal"). `AppealService.getAppeal` itself has no capability
 * check (it's a narrow, id-only read reused internally by `assignReviewer`/`decideAppeal`), so this
 * admin route applies the base admin gate directly for the by-id branch — never relying on
 * `requireSession` alone the way a user-facing route like `GET /api/appeals` correctly does.
 */
export function createAdminAppealGetOrListHandler(authService: AuthService, appealService: AppealService) {
  return async function handleGetOrList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    if (!isAdminRole(platformRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const appeal = await appealService.getAppeal(id);
      return NextResponse.json({ appeal }, { status: 200 });
    }
    const appeals = await appealService.listOpenAppeals(userId, platformRole);
    return NextResponse.json({ appeals }, { status: 200 });
  };
}

async function handleGetOrList(request: NextRequest): Promise<Response> {
  return createAdminAppealGetOrListHandler(getAuthService(), getAppealService())(request);
}

export const GET = withErrorHandling("admin_appeal_get_or_list", handleGetOrList);
