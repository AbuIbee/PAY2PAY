import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { draftTermsSchema } from "@/lib/agreements/validation";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z.object({
  agreementId: z.string().uuid(),
  decision: z.enum(["accept", "reject", "counter"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  counterTerms: draftTermsSchema.optional(),
});

/** FR-AGR-004 — the creditor's accept/reject/counter decision on a submitted, acknowledged draft. */
export function createAgreementDecideHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleDecide(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }

    await agreementService.creditorDecide({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      counterTerms: parsed.data.counterTerms,
    });
    return NextResponse.json({ status: parsed.data.decision }, { status: 200 });
  };
}

async function handleDecide(request: NextRequest): Promise<Response> {
  return createAgreementDecideHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_decide", handleDecide);
