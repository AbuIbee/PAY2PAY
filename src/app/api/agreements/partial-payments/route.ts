import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { getPartialPaymentService } from "@/lib/partialPayments/getPartialPaymentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over PartialPaymentService.listPartialPaymentRequests, which already existed but had no route. */
export function createPartialPaymentListHandler(authService: AuthService, partialPaymentService: PartialPaymentService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const requests = await partialPaymentService.listPartialPaymentRequests(agreementId, userId);
    return NextResponse.json({ requests }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createPartialPaymentListHandler(getAuthService(), getPartialPaymentService())(request);
}

export const GET = withErrorHandling("partial_payment_list", handleList);
