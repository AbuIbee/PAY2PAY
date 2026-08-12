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

const syncSchema = z.object({ disputeId: z.string().uuid() });

/** Read-time sync: closes a resolved_with_amendment dispute once its linked amendment has reached Applied (docs/STATE_MACHINES.md §7's "AmendmentInProgress --> Closed: amendment Applied"). A no-op if the amendment hasn't applied yet. */
export function createAgreementDisputeSyncAmendmentProgressHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = syncSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid disputeId is required.");
    }
    const record = await agreementDisputeService.syncAmendmentProgress({ disputeId: parsed.data.disputeId, actingUserId: userId });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeSyncAmendmentProgressHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_sync_amendment_progress", handlePost);
