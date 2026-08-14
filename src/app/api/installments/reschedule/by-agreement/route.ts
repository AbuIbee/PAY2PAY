import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getRescheduleRequestService } from "@/lib/failedPayments/getRescheduleRequestService";
import type { RescheduleRequestService } from "@/lib/failedPayments/rescheduleRequestService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over RescheduleRequestService.listByAgreementId, for the Payments/reschedule UI. */
export function createRescheduleByAgreementHandler(authService: AuthService, rescheduleRequestService: RescheduleRequestService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const requests = await rescheduleRequestService.listByAgreementId(agreementId, userId);
    return NextResponse.json({ requests }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRescheduleByAgreementHandler(getAuthService(), getRescheduleRequestService())(request);
}

export const GET = withErrorHandling("reschedule_by_agreement", handleList);
