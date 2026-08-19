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

const cancelSchema = z.object({ cardId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) });

export function createCardCancelHandler(authService: AuthService, cardService: CardService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = cancelSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid cancellation request is required.");
    }
    const card = await cardService.cancelCard(parsed.data.cardId, userId, parsed.data.reason);
    return NextResponse.json(card, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createCardCancelHandler(getAuthService(), getCardService())(request);
}

export const POST = withErrorHandling("card_cancel", handlePost);
