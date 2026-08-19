import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { ValidationError } from "@/lib/errors";
import { getCardWebhookService } from "@/lib/cards/getCardWebhookService";
import type { CardWebhookService } from "@/lib/cards/cardWebhookService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PRSprint 24: unauthenticated by design, mirroring /api/kyc/webhook and /api/payments/webhook — CardWebhookService's HMAC signature verification against the raw request body is the sole gate. */
export function createCardWebhookHandler(cardWebhookService: CardWebhookService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-sandbox-card-signature");
    if (!signatureHeader) {
      throw new ValidationError("Missing webhook signature header.");
    }

    const result = await cardWebhookService.receiveWebhook({ rawBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createCardWebhookHandler(getCardWebhookService())(request);
}

export const POST = withErrorHandling("card_webhook", handleWebhook);
