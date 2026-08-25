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

const reviseSchema = z.object({
  agreementId: z.string().uuid(),
  newTerms: draftTermsSchema,
  reason: z.string().trim().min(1).max(2000),
});

/**
 * Agreement Lifecycle V2 (Part 1, Phase 3/4 — "the counterparty must not be forced directly into
 * signing" / negotiation and revision): the shared, versioned pre-signature revision path, reachable
 * by whichever party's turn it currently is (debtor at awaiting_debtor_acknowledgment, creditor at
 * awaiting_creditor_acceptance). AgreementService.reviseTermsBeforeSignature enforces the acting
 * party's turn and creates a new agreement_version rather than mutating the current one in place —
 * this route is a thin wrapper, all state/authorization logic lives server-side in the service.
 */
export function createAgreementReviseTermsHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleRevise(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = reviseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Valid revised terms and a reason are required.");
    }

    const result = await agreementService.reviseTermsBeforeSignature({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      newTerms: parsed.data.newTerms,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ status: result.agreement.status, versionNumber: result.version.versionNumber }, { status: 200 });
  };
}

async function handleRevise(request: NextRequest): Promise<Response> {
  return createAgreementReviseTermsHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_revise_terms", handleRevise);
