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

const decideSchema = z.object({
  partialPaymentRequestId: z.string().uuid(),
  decision: z.enum(["accept", "reject", "counter"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  counterAmountMinorUnits: z.number().int().positive().optional(),
  counterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  counterExplanation: z.string().trim().min(1).max(2000).optional(),
  counterRemainderTreatment: z.string().trim().min(1).max(2000).optional(),
});

/** The creditor's accept/reject/counter decision, gated by approve_partial_payment (PartialPaymentService.decidePartialPayment enforces this). */
export function createPartialPaymentDecideHandler(authService: AuthService, partialPaymentService: PartialPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }
    const record = await partialPaymentService.decidePartialPayment({
      partialPaymentRequestId: parsed.data.partialPaymentRequestId,
      actingUserId: userId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      counterAmountMinorUnits: parsed.data.counterAmountMinorUnits,
      counterDate: parsed.data.counterDate,
      counterExplanation: parsed.data.counterExplanation,
      counterRemainderTreatment: parsed.data.counterRemainderTreatment,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPartialPaymentDecideHandler(getAuthService(), getPartialPaymentService())(request);
}

export const POST = withErrorHandling("partial_payment_decide", handlePost);
