import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { ValidationError } from "@/lib/errors";
import { getKycWebhookService } from "@/lib/kyc/getKycWebhookService";
import type { KycWebhookService } from "@/lib/kyc/kycWebhookService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 9: unauthenticated by design, same reasoning as src/app/api/payments/webhook/route.ts —
 * KycWebhookService's HMAC signature verification against the raw request body is the sole gate.
 */
export function createKycWebhookHandler(kycWebhookService: KycWebhookService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-sandbox-kyc-signature");
    if (!signatureHeader) {
      throw new ValidationError("Missing webhook signature header.");
    }

    const result = await kycWebhookService.receiveWebhook({ rawBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createKycWebhookHandler(getKycWebhookService())(request);
}

export const POST = withErrorHandling("kyc_webhook", handleWebhook);
