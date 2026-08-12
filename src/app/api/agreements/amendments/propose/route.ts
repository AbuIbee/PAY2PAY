import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AmendmentService } from "@/lib/amendments/amendmentService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import { draftTermsSchema } from "@/lib/agreements/validation";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const proposeSchema = z.object({
  agreementId: z.string().uuid(),
  changeType: z.enum(["new_date", "temporary_pause", "reduced_installment", "revised_schedule", "general"]),
  reason: z.string().trim().min(1).max(2000),
  requestedRelief: z.string().trim().min(1).max(2000).optional(),
  proposedEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  proposedTerms: draftTermsSchema,
});

/** Either party may propose (master spec §9: hardship is borrower-initiated; §3's general contractual changes are not restricted to one side). */
export function createAmendmentProposeHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = proposeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid amendment proposal is required.");
    }
    const record = await amendmentService.proposeAmendment({
      agreementId: parsed.data.agreementId,
      changeType: parsed.data.changeType,
      reason: parsed.data.reason,
      requestedRelief: parsed.data.requestedRelief,
      proposedEffectiveDate: parsed.data.proposedEffectiveDate,
      proposedTerms: parsed.data.proposedTerms,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAmendmentProposeHandler(getAuthService(), getAmendmentService())(request);
}

export const POST = withErrorHandling("amendment_propose", handlePost);
