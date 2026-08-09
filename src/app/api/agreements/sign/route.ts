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

const signSchema = z.object({ agreementId: z.string().uuid() });

/**
 * Sprint 5's minimal, version-scoped signing-intent primitive (see
 * AgreementService.signAgreement's doc comment) — not Sprint 6's full electronic-signature
 * evidence bundle, which layers on top of this later.
 */
export function createAgreementSignHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleSign(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = signSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId is required.");

    await agreementService.signAgreement(parsed.data.agreementId, userId);
    return NextResponse.json({ status: "signed" }, { status: 200 });
  };
}

async function handleSign(request: NextRequest): Promise<Response> {
  return createAgreementSignHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_sign", handleSign);
