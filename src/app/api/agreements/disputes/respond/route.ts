import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementDisputeService } from "@/lib/disputes/agreementDisputeService";
import { getAgreementDisputeService } from "@/lib/disputes/getAgreementDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respondSchema = z.object({
  disputeId: z.string().uuid(),
  response: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(z.string().uuid()).optional(),
});

/** Master spec §13: "the other party may respond and upload evidence" — never the party who raised the dispute. */
export function createAgreementDisputeRespondHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = respondSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid response is required.");
    }
    const record = await agreementDisputeService.respondToDispute({ ...parsed.data, actingUserId: userId });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeRespondHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_respond", handlePost);
