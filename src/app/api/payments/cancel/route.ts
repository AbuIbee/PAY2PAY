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

const cancelSchema = z.object({ id: z.string().uuid() });

export function createPaymentCancelHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleCancel(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = cancelSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid cancel request is required.");
    }

    const record = await paymentService.cancelPayment(parsed.data.id, userId);
    return NextResponse.json({ id: record.id, status: record.status }, { status: 200 });
  };
}

async function handleCancel(request: NextRequest): Promise<Response> {
  return createPaymentCancelHandler(getAuthService(), getPaymentService())(request);
}

export const POST = withErrorHandling("payment_cancel", handleCancel);
