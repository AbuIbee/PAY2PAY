import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getPaymentDisputeService } from "@/lib/disputes/getPaymentDisputeService";
import type { PaymentDisputeService } from "@/lib/disputes/paymentDisputeService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin route over PaymentDisputeService.listDisputesForPayment, for the payment detail page's dispute card. */
export function createPaymentDisputesByPaymentHandler(authService: AuthService, disputeService: PaymentDisputeService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const paymentAttemptId = new URL(request.url).searchParams.get("paymentAttemptId");
    if (!paymentAttemptId) throw new ValidationError("paymentAttemptId is required.");

    const disputes = await disputeService.listDisputesForPayment(paymentAttemptId, userId);
    return NextResponse.json({ disputes }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createPaymentDisputesByPaymentHandler(getAuthService(), getPaymentDisputeService())(request);
}

export const GET = withErrorHandling("payment_disputes_by_payment", handleList);
