import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { SettlementService } from "@/lib/settlements/settlementService";
import { getSettlementService } from "@/lib/settlements/getSettlementService";
import { settlementTermsSchema } from "@/lib/settlements/validation";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z.object({
  settlementProposalId: z.string().uuid(),
  decision: z.enum(["accept", "reject", "counter"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  counterTerms: settlementTermsSchema.optional(),
});

/**
 * The counterparty's accept/reject/counter decision on a proposed settlement. `sessionId` is always
 * threaded through: a creditor's "accept" or "counter" is step-up-gated (`SettlementService`'s
 * `requireCreditorStepUp` — widened from "accept" alone during this sprint's Product Owner review
 * pass, since a creditor counter fixes new binding-capable terms exactly like a proposal does).
 */
export function createSettlementDecideHandler(authService: AuthService, settlementService: SettlementService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }
    const record = await settlementService.decideSettlement({
      settlementProposalId: parsed.data.settlementProposalId,
      actingUserId: userId,
      actingSessionId: sessionId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      counterTerms: parsed.data.counterTerms,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createSettlementDecideHandler(getAuthService(), getSettlementService())(request);
}

export const POST = withErrorHandling("settlement_decide", handlePost);
