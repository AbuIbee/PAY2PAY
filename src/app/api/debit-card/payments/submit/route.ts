import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { DebitCardPaymentService } from "@/lib/debitCard/debitCardPaymentService";
import { getDebitCardPaymentService } from "@/lib/debitCard/getDebitCardPaymentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const submitSchema = z.object({ id: z.string().uuid() });

export function createDebitCardSubmitHandler(authService: AuthService, debitCardPaymentService: DebitCardPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = submitSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid submit request is required.");
    }
    const record = await debitCardPaymentService.submitScheduledPayment(parsed.data.id, userId);
    return NextResponse.json({ id: record.id, status: record.status }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createDebitCardSubmitHandler(getAuthService(), getDebitCardPaymentService())(request);
}

export const POST = withErrorHandling("debit_card_payment_submit", handlePost);
