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

const registerSchema = z.object({
  agreementId: z.string().uuid(),
  payerProfileKind: z.enum(["personal", "business"]),
  payerProfileId: z.string().uuid(),
  cardToken: z.string().trim().min(1).max(500),
  cardLast4: z.string().trim().regex(/^\d{4}$/, "cardLast4 must be exactly 4 digits."),
  cardBrand: z.string().trim().min(1).max(50).nullable().default(null),
  expiresAtMonth: z.number().int().min(1).max(12),
  expiresAtYear: z.number().int().min(2000).max(2100),
});

export function createDebitCardRegisterHandler(authService: AuthService, debitCardMethodService: DebitCardMethodService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = registerSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid card-registration request is required.");
    }
    const card = await debitCardMethodService.registerCard({
      agreementId: parsed.data.agreementId,
      payer: { profileKind: parsed.data.payerProfileKind, profileId: parsed.data.payerProfileId },
      cardToken: parsed.data.cardToken,
      cardLast4: parsed.data.cardLast4,
      cardBrand: parsed.data.cardBrand,
      expiresAtMonth: parsed.data.expiresAtMonth,
      expiresAtYear: parsed.data.expiresAtYear,
      actingUserId: userId,
    });
    return NextResponse.json(card, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createDebitCardRegisterHandler(getAuthService(), getDebitCardMethodService())(request);
}

export const POST = withErrorHandling("debit_card_register", handlePost);
