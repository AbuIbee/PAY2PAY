import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reviseSchema = z.object({
  agreementId: z.string().uuid(),
  newFirstPaymentDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "newFirstPaymentDate must be an ISO date (YYYY-MM-DD)."),
});

/**
 * Agreement workflow remediation (Problem 2 — expired first payment date): the resolution path for
 * signAgreementWithEvidence's ScheduleRevisionRequiredError — see
 * AgreementService.reviseFirstPaymentDate's own doc comment for why this is a dedicated, narrower
 * mechanism rather than reusing creditorDecide's "counter" flow.
 */
export function createAgreementReviseFirstPaymentDateHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleRevise(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = reviseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid revised first payment date is required.");
    }

    const result = await agreementService.reviseFirstPaymentDate({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      newFirstPaymentDate: parsed.data.newFirstPaymentDate,
    });
    return NextResponse.json(
      { status: result.agreement.status, firstPaymentDate: result.version.terms.firstPaymentDate },
      { status: 200 },
    );
  };
}

async function handleRevise(request: NextRequest): Promise<Response> {
  return createAgreementReviseFirstPaymentDateHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_revise_first_payment_date", handleRevise);
