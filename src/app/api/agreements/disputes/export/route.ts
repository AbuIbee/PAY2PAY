import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementDisputeService } from "@/lib/disputes/agreementDisputeService";
import { getAgreementDisputeService } from "@/lib/disputes/getAgreementDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Support evidence-package export" (this sprint's own instruction) — the dispute record plus its currently-flagged evidence documents, as a structured bundle. */
export function createAgreementDisputeExportHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const disputeId = new URL(request.url).searchParams.get("disputeId");
    if (!disputeId) throw new ValidationError("disputeId is required.");

    const bundle = await agreementDisputeService.exportEvidencePackage(disputeId, userId);
    return NextResponse.json(bundle, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAgreementDisputeExportHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const GET = withErrorHandling("agreement_dispute_export", handleGet);
