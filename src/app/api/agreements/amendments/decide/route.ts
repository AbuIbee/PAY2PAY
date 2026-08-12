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

const decideSchema = z.object({
  amendmentId: z.string().uuid(),
  decision: z.enum(["accept", "reject", "counter"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  counterTerms: draftTermsSchema.optional(),
  counterReason: z.string().trim().min(1).max(2000).optional(),
  counterRequestedRelief: z.string().trim().min(1).max(2000).optional(),
  counterProposedEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** The counterparty's accept/reject/counter decision on a proposed amendment — never the proposer (AmendmentService.decideAmendment enforces this). */
export function createAmendmentDecideHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }
    const record = await amendmentService.decideAmendment({
      amendmentId: parsed.data.amendmentId,
      actingUserId: userId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      counterTerms: parsed.data.counterTerms,
      counterReason: parsed.data.counterReason,
      counterRequestedRelief: parsed.data.counterRequestedRelief,
      counterProposedEffectiveDate: parsed.data.counterProposedEffectiveDate,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAmendmentDecideHandler(getAuthService(), getAmendmentService())(request);
}

export const POST = withErrorHandling("amendment_decide", handlePost);
