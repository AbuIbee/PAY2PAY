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

const reportSchema = z.object({ cardId: z.string().uuid(), reason: z.enum(["lost", "stolen"]) });

export function createCardReportLostStolenHandler(authService: AuthService, cardService: CardService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = reportSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid report request is required.");
    }
    const { oldCard, replacement } = await cardService.reportLostOrStolen(parsed.data.cardId, userId, parsed.data.reason);
    return NextResponse.json({ oldCard, replacement }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createCardReportLostStolenHandler(getAuthService(), getCardService())(request);
}

export const POST = withErrorHandling("card_report_lost_stolen", handlePost);
