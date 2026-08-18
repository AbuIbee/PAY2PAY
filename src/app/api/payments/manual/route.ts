import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import type { PaymentService } from "@/lib/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md) precedent,
// applied here for the same reason as payments/create: PaymentService's idempotency-key dedupe
// prevents duplicate charges, not unbounded distinct manual-payment-recording attempts.
const MANUAL_PAYMENT_LIMIT_PER_USER = 30;
const MANUAL_PAYMENT_WINDOW_MS = 60 * 60 * 1000;

const recordManualPaymentSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  agreementId: z.string().uuid(),
  amountMinorUnits: z.number().int().positive(),
});

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md):
 * records a payment collected outside this platform's payment rails. PaymentService.
 * recordManualOffPlatformPayment itself enforces that the caller is the agreement's debtor and that
 * the amount does not exceed the remaining balance — this route is a thin, input-validating wrapper.
 */
export function createManualPaymentHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = recordManualPaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid manual payment request is required.");
    }

    if (!(await checkRateLimit(`payment-manual:user:${userId}`, MANUAL_PAYMENT_LIMIT_PER_USER, MANUAL_PAYMENT_WINDOW_MS))) {
      throw new RateLimitedError("Too many manual payment attempts. Please try again later.");
    }

    const record = await paymentService.recordManualOffPlatformPayment({
      idempotencyKey: parsed.data.idempotencyKey,
      agreementId: parsed.data.agreementId,
      amountMinorUnits: parsed.data.amountMinorUnits,
      actingUserId: userId,
    });
    return NextResponse.json({ id: record.id, status: record.status }, { status: 201 });
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createManualPaymentHandler(getAuthService(), getPaymentService())(request);
}

export const POST = withErrorHandling("payment_manual_record", handleCreate);
