import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { getPartialPaymentService } from "@/lib/partialPayments/getPartialPaymentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recordPaymentSchema = z.object({
  partialPaymentRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
});

/** Links an already-succeeded payment_attempt (created through the normal payment gate) to an awaiting-payment partial payment request. */
export function createPartialPaymentRecordPaymentHandler(authService: AuthService, partialPaymentService: PartialPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = recordPaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid partialPaymentRequestId and paymentAttemptId are required.");
    }
    const record = await partialPaymentService.recordPayment({
      partialPaymentRequestId: parsed.data.partialPaymentRequestId,
      paymentAttemptId: parsed.data.paymentAttemptId,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPartialPaymentRecordPaymentHandler(getAuthService(), getPartialPaymentService())(request);
}

export const POST = withErrorHandling("partial_payment_record_payment", handlePost);
