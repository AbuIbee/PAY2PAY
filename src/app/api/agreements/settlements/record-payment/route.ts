import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { SettlementService } from "@/lib/settlements/settlementService";
import { getSettlementService } from "@/lib/settlements/getSettlementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recordPaymentSchema = z.object({
  settlementProposalId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
});

/** Links an already-succeeded payment_attempt toward an awaiting-payment settlement; completes it (SETTLED_IN_FULL, never PAID_IN_FULL) once the full amount clears. */
export function createSettlementRecordPaymentHandler(authService: AuthService, settlementService: SettlementService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = recordPaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid settlementProposalId and paymentAttemptId are required.");
    }
    const record = await settlementService.recordSettlementPayment({
      settlementProposalId: parsed.data.settlementProposalId,
      paymentAttemptId: parsed.data.paymentAttemptId,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createSettlementRecordPaymentHandler(getAuthService(), getSettlementService())(request);
}

export const POST = withErrorHandling("settlement_record_payment", handlePost);
