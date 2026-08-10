import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { SignatureService } from "@/lib/signatures/signatureService";
import { getSignatureService } from "@/lib/signatures/getSignatureService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 6: "Both parties must have authorized access to the signed PDF" / "Never expose private
 * buckets publicly." Returns a short-lived signed URL, freshly issued on every call —
 * SignatureService.getSignedPdfUrl re-runs full party authorization (via AgreementService.
 * getAgreement) before ever asking DocumentStorage for a URL.
 */
export function createAgreementPdfHandler(authService: AuthService, signatureService: SignatureService) {
  return async function handlePdf(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const signedUrl = await signatureService.getSignedPdfUrl(id, userId);
    return NextResponse.json({ signedUrl }, { status: 200 });
  };
}

async function handlePdf(request: NextRequest): Promise<Response> {
  return createAgreementPdfHandler(getAuthService(), getSignatureService())(request);
}

export const GET = withErrorHandling("agreement_pdf", handlePdf);
