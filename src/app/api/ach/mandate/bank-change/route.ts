import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bankChangeSchema = z.object({
  agreementId: z.string().uuid(),
  payerProfileKind: z.enum(["personal", "business"]),
  payerProfileId: z.string().uuid(),
  newBankAccountRef: z.string().trim().min(1).max(500),
});

/** Sprint 11's "bank-change hook" — revokes the current mandate and authorizes a new one, linked via supersedesMandateId. */
export function createAchMandateBankChangeHandler(authService: AuthService, achMandateService: AchMandateService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = bankChangeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid bank-change request is required.");
    }
    const mandate = await achMandateService.handleBankChange({
      agreementId: parsed.data.agreementId,
      payer: { profileKind: parsed.data.payerProfileKind, profileId: parsed.data.payerProfileId },
      newBankAccountRef: parsed.data.newBankAccountRef,
      actingUserId: userId,
    });
    return NextResponse.json(mandate, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAchMandateBankChangeHandler(getAuthService(), getAchMandateService())(request);
}

export const POST = withErrorHandling("ach_mandate_bank_change", handlePost);
