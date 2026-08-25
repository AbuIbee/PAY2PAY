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
 * Agreement Lifecycle V2 (Part 6 — Print/PDF): streams a freshly generated PDF for the current
 * version, reachable in ANY agreement state (Draft, Review, mid-signing, or fully executed) —
 * unlike GET /api/agreements/pdf, which only serves the stored, immutable executed PDF once one
 * exists. Same authorization as every other agreement read (SignatureService.getPreviewPdf calls
 * AgreementService.getAgreement, which runs the standard authorizeEitherParty check) — no
 * guessable-URL/ID access. Served inline as bytes (not a signed storage URL) so the browser's own
 * Print / Save as PDF works directly from the response.
 */
export function createAgreementPdfPreviewHandler(authService: AuthService, signatureService: SignatureService) {
  return async function handlePreview(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const pdfBytes = await signatureService.getPreviewPdf(id, userId);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="agreement-${id}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  };
}

async function handlePreview(request: NextRequest): Promise<Response> {
  return createAgreementPdfPreviewHandler(getAuthService(), getSignatureService())(request);
}

export const GET = withErrorHandling("agreement_pdf_preview", handlePreview);
