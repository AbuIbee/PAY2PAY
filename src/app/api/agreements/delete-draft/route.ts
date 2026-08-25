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

const deleteDraftSchema = z.object({ agreementId: z.string().uuid() });

/**
 * Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): irreversible hard delete, only available
 * while the agreement is still an unsent Draft. AgreementService.deleteDraft is the sole
 * authorization/status gate — this route is a thin wrapper.
 */
export function createAgreementDeleteDraftHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleDeleteDraft(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = deleteDraftSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId is required.");

    await agreementService.deleteDraft(parsed.data.agreementId, userId);
    return NextResponse.json({ status: "deleted" }, { status: 200 });
  };
}

async function handleDeleteDraft(request: NextRequest): Promise<Response> {
  return createAgreementDeleteDraftHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_delete_draft", handleDeleteDraft);
