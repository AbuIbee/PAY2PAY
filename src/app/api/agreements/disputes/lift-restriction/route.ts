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

const liftSchema = z.object({
  disputeId: z.string().uuid(),
  target: z.enum(["under_review", "closed"]),
  resolutionNotes: z.string().trim().min(1).max(4000).optional(),
});

/** Platform Admin/Owner only — "restriction lifted, review continues" or "restriction resolves the dispute" (docs/STATE_MACHINES.md §7); the admin chooses which. */
export function createAgreementDisputeLiftRestrictionHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = liftSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid target is required.");
    }
    const record = await agreementDisputeService.liftRestriction({ ...parsed.data, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeLiftRestrictionHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_lift_restriction", handlePost);
