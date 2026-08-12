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

const proposeSchema = z.object({
  agreementId: z.string().uuid(),
  proposedAmountMinorUnits: z.number().int().positive(),
  proposedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  explanation: z.string().trim().min(1).max(2000).optional(),
  remainderTreatment: z.string().trim().min(1).max(2000).optional(),
  installmentScheduleItemId: z.string().uuid().optional(),
});

/** Master spec §11: only the borrower may propose a partial payment (PartialPaymentService.proposePartialPayment enforces this). */
export function createPartialPaymentProposeHandler(authService: AuthService, partialPaymentService: PartialPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = proposeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid partial payment proposal is required.");
    }
    const record = await partialPaymentService.proposePartialPayment({
      agreementId: parsed.data.agreementId,
      proposedAmountMinorUnits: parsed.data.proposedAmountMinorUnits,
      proposedDate: parsed.data.proposedDate,
      explanation: parsed.data.explanation,
      remainderTreatment: parsed.data.remainderTreatment,
      installmentScheduleItemId: parsed.data.installmentScheduleItemId,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPartialPaymentProposeHandler(getAuthService(), getPartialPaymentService())(request);
}

export const POST = withErrorHandling("partial_payment_propose", handlePost);
