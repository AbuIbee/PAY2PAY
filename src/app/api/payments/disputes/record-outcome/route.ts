import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { PaymentDisputeService } from "@/lib/disputes/paymentDisputeService";
import { getPaymentDisputeService } from "@/lib/disputes/getPaymentDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const outcomeSchema = z.object({
  paymentDisputeId: z.string().uuid(),
  outcome: z.enum(["upheld", "denied"]),
  resolutionNotes: z.string().trim().min(1).max(4000).optional(),
});

/** Platform Admin/Owner only — records the processor's own determination ("the processor handles payment dispute outcome," this sprint's own instruction). Never a party self-service action. */
export function createPaymentDisputeRecordOutcomeHandler(authService: AuthService, paymentDisputeService: PaymentDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = outcomeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid outcome is required.");
    }
    const record = await paymentDisputeService.recordProcessorOutcome({ ...parsed.data, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPaymentDisputeRecordOutcomeHandler(getAuthService(), getPaymentDisputeService())(request);
}

export const POST = withErrorHandling("payment_dispute_record_outcome", handlePost);
