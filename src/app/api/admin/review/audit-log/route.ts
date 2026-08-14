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

/** GET /api/admin/review/audit-log?targetResourceType=&targetResourceId= — requires "review_audit_logs"; also satisfies "review payment failures" when the target is a payment-adjacent resource (see AdminCaseReviewService's own doc comment). */
export function createAdminReviewAuditLogHandler(authService: AuthService, reviewService: AdminCaseReviewService) {
  return async function handleReview(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const targetResourceType = searchParams.get("targetResourceType");
    const targetResourceId = searchParams.get("targetResourceId");
    if (!targetResourceType || !targetResourceId) {
      throw new ValidationError("targetResourceType and targetResourceId are required.");
    }
    const events = await reviewService.listAuditEventsForTarget({ targetResourceType, targetResourceId, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ events }, { status: 200 });
  };
}

async function handleReview(request: NextRequest): Promise<Response> {
  return createAdminReviewAuditLogHandler(getAuthService(), getAdminCaseReviewService())(request);
}

export const GET = withErrorHandling("admin_review_audit_log", handleReview);
