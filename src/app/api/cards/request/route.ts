import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getCardService } from "@/lib/cards/getCardService";
import type { CardService } from "@/lib/cards/cardService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md) precedent,
// applied here for the same reason as ach/mandate: bounds unbounded card-issuance-request attempts.
const CARD_REQUEST_LIMIT_PER_USER = 10;
const CARD_REQUEST_WINDOW_MS = 60 * 60 * 1000;

const requestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  cardholderKind: z.enum(["personal", "business"]),
  cardholderId: z.string().uuid(),
  cardType: z.enum(["virtual", "physical"]),
  shippingAddress: z.record(z.string(), z.string()).optional(),
});

export function createCardRequestHandler(authService: AuthService, cardService: CardService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid card request is required.");
    }
    if (!(await checkRateLimit(`card-request:user:${userId}`, CARD_REQUEST_LIMIT_PER_USER, CARD_REQUEST_WINDOW_MS))) {
      throw new RateLimitedError("Too many card requests. Please try again later.");
    }
    const card = await cardService.requestCard({
      idempotencyKey: parsed.data.idempotencyKey,
      cardholder: { kind: parsed.data.cardholderKind, id: parsed.data.cardholderId },
      cardType: parsed.data.cardType,
      shippingAddress: parsed.data.shippingAddress ?? null,
      actingUserId: userId,
    });
    return NextResponse.json(card, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createCardRequestHandler(getAuthService(), getCardService())(request);
}

export const POST = withErrorHandling("card_request", handlePost);
