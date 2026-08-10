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

const acknowledgeSchema = z.object({ agreementId: z.string().uuid() });

/** FR-AGR-003 — the debtor's formal, distinct, attributable acknowledgment event. */
export function createAgreementAcknowledgeHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleAcknowledge(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = acknowledgeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId is required.");

    await agreementService.acknowledgeDebt(parsed.data.agreementId, userId);
    return NextResponse.json({ status: "acknowledged" }, { status: 200 });
  };
}

async function handleAcknowledge(request: NextRequest): Promise<Response> {
  return createAgreementAcknowledgeHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_acknowledge", handleAcknowledge);
