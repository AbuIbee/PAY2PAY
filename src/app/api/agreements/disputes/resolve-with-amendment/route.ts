import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementDisputeService } from "@/lib/disputes/agreementDisputeService";
import { getAgreementDisputeService } from "@/lib/disputes/getAgreementDisputeService";
import { draftTermsSchema } from "@/lib/agreements/validation";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  disputeId: z.string().uuid(),
  changeType: z.enum(["new_date", "temporary_pause", "reduced_installment", "revised_schedule", "general"]),
  proposedTerms: draftTermsSchema,
  requestedRelief: z.string().trim().min(1).max(2000).optional(),
  proposedEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** "Resolution requires a signed amendment" (docs/STATE_MACHINES.md §7) — hands off to Sprint 14's AmendmentService; the resulting amendment's own accept/reject/counter/dual-signature lifecycle is unaffected by this route. */
export function createAgreementDisputeResolveWithAmendmentHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = resolveSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid amendment resolution is required.");
    }
    const record = await agreementDisputeService.resolveWithAmendment({ ...parsed.data, actingUserId: userId });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeResolveWithAmendmentHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_resolve_with_amendment", handlePost);
