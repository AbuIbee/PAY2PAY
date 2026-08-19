import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getCardService } from "@/lib/cards/getCardService";
import type { CardService } from "@/lib/cards/cardService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createCardListHandler(authService: AuthService, cardService: CardService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const cardholderKind = searchParams.get("cardholderKind");
    const cardholderId = searchParams.get("cardholderId");
    if ((cardholderKind !== "personal" && cardholderKind !== "business") || !cardholderId) {
      throw new ValidationError("cardholderKind (personal|business) and cardholderId are required.");
    }
    const cards = await cardService.listCardsForParty(userId, { kind: cardholderKind, id: cardholderId });
    return NextResponse.json({ cards }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createCardListHandler(getAuthService(), getCardService())(request);
}

export const GET = withErrorHandling("card_list", handleGet);
