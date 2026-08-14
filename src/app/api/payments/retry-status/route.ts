import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getPaymentRetryService } from "@/lib/failedPayments/getPaymentRetryService";
import type { PaymentRetryService } from "@/lib/failedPayments/paymentRetryService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over PaymentRetryService.findForOriginalPayment, for the failed-payment detail card. */
export function createPaymentRetryStatusHandler(authService: AuthService, retryService: PaymentRetryService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const paymentId = new URL(request.url).searchParams.get("paymentId");
    if (!paymentId) throw new ValidationError("paymentId is required.");

    const retry = await retryService.findForOriginalPayment(paymentId, userId);
    return NextResponse.json({ retry }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createPaymentRetryStatusHandler(getAuthService(), getPaymentRetryService())(request);
}

export const GET = withErrorHandling("payment_retry_status", handleGet);
