import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { RiskEventService } from "@/lib/risk/riskEventService";
import { getRiskEventService } from "@/lib/risk/getRiskEventService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;

/**
 * SPRINT_19_FraudRisk_SecurityHardening §13 (Fraud Review / Admin Safety): admin-only visibility
 * into recorded risk signals, gated by the `review_fraud_alert` capability. Authorization is
 * enforced inside RiskEventService itself (docs/SECURITY_MODEL.md §11's two-independent-layers
 * principle), mirroring AdminCaseReviewService's established `roles.requireCapability` pattern.
 * Never exposes raw credentials — the underlying table never stores any (see
 * src/db/schema/riskSignal.ts's own doc comment).
 */
export function createRiskEventsListHandler(authService: AuthService, riskEventService: RiskEventService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const url = new URL(request.url);
    const openOnly = url.searchParams.get("openOnly") === "true";
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isSafeInteger(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;
    const events = await riskEventService.listRecentForAdmin(userId, platformRole, { openOnly, limit });
    return NextResponse.json({ events }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRiskEventsListHandler(getAuthService(), getRiskEventService())(request);
}

export const GET = withErrorHandling("admin_risk_events_list", handleList);
