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

const submitSchema = z.object({ agreementId: z.string().uuid() });

export function createAgreementSubmitHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = submitSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId is required.");

    await agreementService.submitDraft(parsed.data.agreementId, userId);
    return NextResponse.json({ status: "submitted" }, { status: 200 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createAgreementSubmitHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_submit", handleSubmit);
