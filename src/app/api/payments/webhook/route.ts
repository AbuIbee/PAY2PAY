import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { ValidationError } from "@/lib/errors";
import { getPaymentWebhookService } from "@/lib/payments/getPaymentWebhookService";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 9: unauthenticated by design (the sandbox provider cannot hold a PAY2PAY session cookie) —
 * `PaymentWebhookService.receiveWebhook` is the sole gate, via HMAC signature verification against
 * the raw request body. Reads the body as raw text (not `request.json()`) because signature
 * verification requires the exact bytes the sender signed, not a JSON round-trip that could
 * reformat them.
 */
export function createPaymentWebhookHandler(paymentWebhookService: PaymentWebhookService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-sandbox-payment-signature");
    if (!signatureHeader) {
      throw new ValidationError("Missing webhook signature header.");
    }

    const result = await paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createPaymentWebhookHandler(getPaymentWebhookService())(request);
}

export const POST = withErrorHandling("payment_webhook", handleWebhook);
