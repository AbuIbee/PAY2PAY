import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";
import type { SignatureService } from "@/lib/signatures/signatureService";
import { getSignatureService } from "@/lib/signatures/getSignatureService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const signSchema = z.object({
  agreementId: z.string().uuid(),
  authMethod: z.enum(["totp", "sms"]),
  consentVersion: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100),
  deviceInfo: z.unknown().optional(),
});

/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): supersedes Sprint 5's raw
 * `agreementService.signAgreement` call — signing now goes through SignatureService, which gates on
 * a fresh step-up challenge and, for a business signer, valid signing authority before ever calling
 * signAgreement (unchanged), and captures the full evidence bundle this sprint requires. Per the
 * later "Remove Step 4 — Identity Verification" decision (see SignatureService's own doc comment),
 * this gate does not include full identity/KYC verification.
 */
export function createAgreementSignHandler(authService: AuthService, signatureService: SignatureService) {
  return async function handleSign(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = signSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid signing request is required.");
    }

    const result = await signatureService.sign({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      actingSessionId: sessionId,
      authMethod: parsed.data.authMethod,
      consentVersion: parsed.data.consentVersion,
      timezone: parsed.data.timezone,
      deviceInfo: parsed.data.deviceInfo ?? null,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json(
      { status: result.agreementStatus, signatureEventId: result.signatureEvent.id, pdfGenerated: result.pdfGenerated },
      { status: 200 },
    );
  };
}

async function handleSign(request: NextRequest): Promise<Response> {
  return createAgreementSignHandler(getAuthService(), getSignatureService())(request);
}

export const POST = withErrorHandling("agreement_sign", handleSign);
