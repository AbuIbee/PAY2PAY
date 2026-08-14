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

/** GET /api/admin/review/verification?profileKind=personal|business&profileId=... — requires "review_verification_status"; reuses Sprint 3's VerificationService.getVerificationState directly. */
export function createAdminReviewVerificationHandler(authService: AuthService, reviewService: AdminCaseReviewService) {
  return async function handleReview(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const profileKind = searchParams.get("profileKind");
    const profileId = searchParams.get("profileId");
    if ((profileKind !== "personal" && profileKind !== "business") || !profileId) {
      throw new ValidationError("profileKind (personal|business) and profileId are required.");
    }
    const state = await reviewService.getVerificationStatus({ profileKind, profileId, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ state }, { status: 200 });
  };
}

async function handleReview(request: NextRequest): Promise<Response> {
  return createAdminReviewVerificationHandler(getAuthService(), getAdminCaseReviewService())(request);
}

export const GET = withErrorHandling("admin_review_verification", handleReview);
