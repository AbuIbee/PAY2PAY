import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cancelSchema = z.object({ agreementId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) });

/**
 * Agreement Lifecycle V2 UAT (Defect 3 — Cancel/Withdraw): for a sent-but-unexecuted agreement.
 * AgreementService.cancelAgreement is the sole authorization/status gate (either party, only while
 * pre-execution) — preserves audit/version history, never erases anything.
 */
export function createAgreementCancelHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleCancel(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = cancelSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A reason is required to cancel this agreement.");
    }

    const result = await agreementService.cancelAgreement(parsed.data.agreementId, userId, parsed.data.reason);
    return NextResponse.json({ status: result.agreement.status }, { status: 200 });
  };
}

async function handleCancel(request: NextRequest): Promise<Response> {
  return createAgreementCancelHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_cancel", handleCancel);
