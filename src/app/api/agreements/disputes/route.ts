import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementDisputeService } from "@/lib/disputes/agreementDisputeService";
import { getAgreementDisputeService } from "@/lib/disputes/getAgreementDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over AgreementDisputeService.listDisputes, which already existed but had no route. */
export function createAgreementDisputeListHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const disputes = await agreementDisputeService.listDisputes(agreementId, userId);
    return NextResponse.json({ disputes }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAgreementDisputeListHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const GET = withErrorHandling("agreement_dispute_list", handleList);
