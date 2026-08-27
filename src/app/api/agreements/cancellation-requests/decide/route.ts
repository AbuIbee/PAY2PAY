import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementCancellationService } from "@/lib/agreements/agreementCancellationService";
import { getAgreementCancellationService } from "@/lib/agreements/getAgreementCancellationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z.object({
  cancellationRequestId: z.string().uuid(),
  decision: z.enum(["accept", "reject"]),
  rejectedReason: z.string().trim().min(1).max(2000).optional(),
});

/** The counterparty's accept/decline decision (AgreementCancellationService.decideCancellation enforces "only the other party may decide"). Accepting writes agreement.status = mutually_canceled; declining leaves the agreement untouched. */
export function createAgreementCancellationDecideHandler(authService: AuthService, cancellationService: AgreementCancellationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }
    const record = await cancellationService.decideCancellation({
      cancellationRequestId: parsed.data.cancellationRequestId,
      actingUserId: userId,
      decision: parsed.data.decision,
      rejectedReason: parsed.data.rejectedReason,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementCancellationDecideHandler(getAuthService(), getAgreementCancellationService())(request);
}

export const POST = withErrorHandling("agreement_cancellation_decide", handlePost);
