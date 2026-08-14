import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { SupportCaseService } from "@/lib/admin/supportCaseService";
import { getSupportCaseService } from "@/lib/admin/getSupportCaseService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/support-cases?id=... — a single case; GET /api/admin/support-cases (no query) — every still-open case. */
export function createSupportCaseGetOrListHandler(authService: AuthService, supportCaseService: SupportCaseService) {
  return async function handleGetOrList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const supportCase = await supportCaseService.getCase(id, userId, platformRole);
      return NextResponse.json({ supportCase }, { status: 200 });
    }
    const cases = await supportCaseService.listOpenCases(userId, platformRole);
    return NextResponse.json({ cases }, { status: 200 });
  };
}

async function handleGetOrList(request: NextRequest): Promise<Response> {
  return createSupportCaseGetOrListHandler(getAuthService(), getSupportCaseService())(request);
}

export const GET = withErrorHandling("support_case_get_or_list", handleGetOrList);
