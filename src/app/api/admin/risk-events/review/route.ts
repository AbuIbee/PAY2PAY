import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { RiskEventService } from "@/lib/risk/riskEventService";
import { getRiskEventService } from "@/lib/risk/getRiskEventService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["reviewed", "dismissed"]),
});

/** SPRINT_19_FraudRisk_SecurityHardening §13: admin decision on a flagged risk signal. Never deletes or edits the original observation — only adds a review decision on top (append-only ledger, see riskSignal.ts's own doc comment). */
export function createRiskEventsReviewHandler(authService: AuthService, riskEventService: RiskEventService) {
  return async function handleReview(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = reviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A risk event id and decision (reviewed or dismissed) are required.");
    }
    const record = await riskEventService.markReviewed(userId, platformRole, parsed.data.id, userId, parsed.data.decision);
    return NextResponse.json({ event: record }, { status: 200 });
  };
}

async function handleReview(request: NextRequest): Promise<Response> {
  return createRiskEventsReviewHandler(getAuthService(), getRiskEventService())(request);
}

export const POST = withErrorHandling("admin_risk_events_review", handleReview);
