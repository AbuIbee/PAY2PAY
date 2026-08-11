import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import type { PaymentService } from "@/lib/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refundSchema = z.object({ id: z.string().uuid() });

/** Sprint 9: PaymentService.refundPayment restricts this to the payment's recipient — see docs/PAYMENT_ARCHITECTURE.md §9's note that a general voluntary-refund feature isn't a named MVP capability; this endpoint exists to exercise the abstraction's refund entry point, not to model the full dispute-driven refund flow (Sprint 9/10+ scope). */
export function createPaymentRefundHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleRefund(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = refundSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid refund request is required.");
    }

    const record = await paymentService.refundPayment(parsed.data.id, userId);
    return NextResponse.json({ id: record.id, status: record.status }, { status: 200 });
  };
}

async function handleRefund(request: NextRequest): Promise<Response> {
  return createPaymentRefundHandler(getAuthService(), getPaymentService())(request);
}

export const POST = withErrorHandling("payment_refund", handleRefund);
