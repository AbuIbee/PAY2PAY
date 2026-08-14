import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminCaseReviewService } from "@/lib/admin/adminCaseReviewService";
import { getAdminCaseReviewService } from "@/lib/admin/getAdminCaseReviewService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/review/dispute?kind=agreement|payment&disputeId=... — requires "review_dispute"; reuses Sprint 16's own dispute repositories directly (not the party-gated services). */
export function createAdminReviewDisputeHandler(authService: AuthService, reviewService: AdminCaseReviewService) {
  return async function handleReview(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const kind = searchParams.get("kind");
    const disputeId = searchParams.get("disputeId");
    if ((kind !== "agreement" && kind !== "payment") || !disputeId) {
      throw new ValidationError("kind (agreement|payment) and disputeId are required.");
    }
    const dispute =
      kind === "agreement"
        ? await reviewService.getAgreementDispute({ disputeId, actingUserId: userId, actingRole: platformRole })
        : await reviewService.getPaymentDispute({ disputeId, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ dispute }, { status: 200 });
  };
}

async function handleReview(request: NextRequest): Promise<Response> {
  return createAdminReviewDisputeHandler(getAuthService(), getAdminCaseReviewService())(request);
}

export const GET = withErrorHandling("admin_review_dispute", handleReview);
