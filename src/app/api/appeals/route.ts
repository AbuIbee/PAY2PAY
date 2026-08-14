import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AppealService } from "@/lib/admin/appealService";
import { getAppealService } from "@/lib/admin/getAppealService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/appeals — the caller's own appeals only; `appealingUserId` always comes from the session, never a request parameter (mirrors Sprint 17's own GET /api/notifications precedent exactly). */
export function createMyAppealsHandler(authService: AuthService, appealService: AppealService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const appeals = await appealService.listAppealsForUser(userId);
    return NextResponse.json({ appeals }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createMyAppealsHandler(getAuthService(), getAppealService())(request);
}

export const GET = withErrorHandling("appeal_list_mine", handleList);
