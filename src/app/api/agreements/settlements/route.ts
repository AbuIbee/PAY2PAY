import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { SettlementService } from "@/lib/settlements/settlementService";
import { getSettlementService } from "@/lib/settlements/getSettlementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over SettlementService.listSettlementProposals, which already existed but had no route. */
export function createSettlementListHandler(authService: AuthService, settlementService: SettlementService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const proposals = await settlementService.listSettlementProposals(agreementId, userId);
    return NextResponse.json({ proposals }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createSettlementListHandler(getAuthService(), getSettlementService())(request);
}

export const GET = withErrorHandling("settlement_list", handleList);
