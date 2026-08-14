import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AmendmentService } from "@/lib/amendments/amendmentService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin route over AmendmentService.listAmendments, which already existed but had no
 * route — propose/decide/sign/withdraw were exposed with no way to list an agreement's amendment
 * history for the detail-page panel.
 */
export function createAmendmentListHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const amendments = await amendmentService.listAmendments(agreementId, userId);
    return NextResponse.json({ amendments }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAmendmentListHandler(getAuthService(), getAmendmentService())(request);
}

export const GET = withErrorHandling("amendment_list", handleList);
