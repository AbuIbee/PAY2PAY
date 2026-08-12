import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { DebitCardMethodService } from "@/lib/debitCard/debitCardMethodService";
import { getDebitCardMethodService } from "@/lib/debitCard/getDebitCardMethodService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replaceSchema = z.object({
  agreementId: z.string().uuid(),
  payerProfileKind: z.enum(["personal", "business"]),
  payerProfileId: z.string().uuid(),
  newCardToken: z.string().trim().min(1).max(500),
  cardLast4: z.string().trim().regex(/^\d{4}$/, "cardLast4 must be exactly 4 digits."),
  cardBrand: z.string().trim().min(1).max(50).nullable().default(null),
  expiresAtMonth: z.number().int().min(1).max(12),
  expiresAtYear: z.number().int().min(2000).max(2100),
  reason: z.string().trim().min(1).max(2000),
});

export function createDebitCardReplaceHandler(authService: AuthService, debitCardMethodService: DebitCardMethodService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = replaceSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid card-replacement request is required.");
    }
    const card = await debitCardMethodService.replaceCard({
      agreementId: parsed.data.agreementId,
      payer: { profileKind: parsed.data.payerProfileKind, profileId: parsed.data.payerProfileId },
      newCardToken: parsed.data.newCardToken,
      cardLast4: parsed.data.cardLast4,
      cardBrand: parsed.data.cardBrand,
      expiresAtMonth: parsed.data.expiresAtMonth,
      expiresAtYear: parsed.data.expiresAtYear,
      reason: parsed.data.reason,
      actingUserId: userId,
    });
    return NextResponse.json(card, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createDebitCardReplaceHandler(getAuthService(), getDebitCardMethodService())(request);
}

export const POST = withErrorHandling("debit_card_replace", handlePost);
