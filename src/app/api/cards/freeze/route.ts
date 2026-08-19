import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getCardService } from "@/lib/cards/getCardService";
import type { CardService } from "@/lib/cards/cardService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const freezeSchema = z.object({ cardId: z.string().uuid(), reason: z.string().trim().max(2000).optional() });

export function createCardFreezeHandler(authService: AuthService, cardService: CardService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = freezeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid freeze request is required.");
    }
    const card = await cardService.freezeCard(parsed.data.cardId, userId, parsed.data.reason ?? null);
    return NextResponse.json(card, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createCardFreezeHandler(getAuthService(), getCardService())(request);
}

export const POST = withErrorHandling("card_freeze", handlePost);
