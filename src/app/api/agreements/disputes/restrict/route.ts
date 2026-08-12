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

const restrictSchema = z.object({
  disputeId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

/** Platform Admin/Owner only — "processor/administrator imposes a restriction" (docs/STATE_MACHINES.md §7). Never a party self-service action. */
export function createAgreementDisputeRestrictHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = restrictSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid reason is required.");
    }
    const record = await agreementDisputeService.restrictDispute({ ...parsed.data, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeRestrictHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_restrict", handlePost);
