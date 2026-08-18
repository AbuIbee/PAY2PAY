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

const confirmSchema = z.object({ id: z.string().uuid() });

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md): the
 * recipient's optional, purely evidentiary confirmation of a manually-recorded payment —
 * PaymentService.confirmManualPayment enforces that only the payment's recipient may call this.
 */
export function createConfirmManualPaymentHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleConfirm(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid confirmation request is required.");
    }

    const record = await paymentService.confirmManualPayment(parsed.data.id, userId);
    return NextResponse.json({ id: record.id, recipientConfirmedAt: record.recipientConfirmedAt }, { status: 200 });
  };
}

async function handleConfirm(request: NextRequest): Promise<Response> {
  return createConfirmManualPaymentHandler(getAuthService(), getPaymentService())(request);
}

export const POST = withErrorHandling("payment_manual_confirm", handleConfirm);
