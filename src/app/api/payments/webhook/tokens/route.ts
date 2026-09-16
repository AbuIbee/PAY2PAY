import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { getAdyenTokenLifecycleService } from "@/lib/payments/getAdyenTokenLifecycleService";
import type { AdyenTokenLifecycleService } from "@/lib/payments/adyenTokenLifecycleService";
import type { AdyenTokenLifecycleEvent } from "@/lib/payments/adyenPaymentProvider";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Narrow interface onto exactly the two `AdyenPaymentProvider` methods this route needs — avoids depending on the entire class, and lets tests supply a minimal double without constructing a real provider. */
export interface AdyenTokenWebhookVerifier {
  verifyTokenLifecycleWebhookSignature(rawBody: string, hmacSignatureHeader: string | null, protocolHeader: string | null): boolean;
  parseTokenLifecycleWebhookEvent(rawBody: string): AdyenTokenLifecycleEvent | null;
}

/**
 * PAID2YOU — B0-D ADYEN PHASE 2 (item 4 — token lifecycle). A DEDICATED route, never the existing
 * `/api/payments/webhook` — see `AdyenPaymentProvider`'s own module doc comment, Phase 2 item 3, for
 * exactly why: this webhook family signs differently (HMAC in the `hmacsignature`/`protocol` HTTP
 * headers over the raw body, never embedded in the JSON body the way Standard notifications work).
 * Fails closed on any signature/config problem — never processes an unverified body. Idempotent by
 * construction: `AdyenTokenLifecycleService.handleEvent`'s own downstream writes
 * (`disableAccountByProviderRef`/`revokeAllForBankAccountRef`) are themselves idempotent, so a
 * redelivered webhook is always safe to reprocess.
 */
export function createAdyenTokenWebhookHandler(verifier: AdyenTokenWebhookVerifier, lifecycleService: AdyenTokenLifecycleService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const hmacSignatureHeader = request.headers.get("hmacsignature");
    const protocolHeader = request.headers.get("protocol");
    if (!verifier.verifyTokenLifecycleWebhookSignature(rawBody, hmacSignatureHeader, protocolHeader)) {
      logger.error("adyen_token_webhook_signature_invalid", {});
      throw new ForbiddenError("Invalid webhook signature.");
    }
    const event = verifier.parseTokenLifecycleWebhookEvent(rawBody);
    if (!event) {
      // A validly-signed but unparseable/unexpected-shape body — accept (200) rather than error, so
      // Adyen does not endlessly retry a payload this route will never be able to parse; nothing is
      // silently treated as a lifecycle event.
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }
    await lifecycleService.handleEvent(event);
    return NextResponse.json({ status: "processed" }, { status: 200 });
  };
}

function resolveVerifier(): AdyenTokenWebhookVerifier {
  const provider = getPaymentProvider();
  if (provider.providerName !== "adyen" || typeof (provider as Partial<AdyenTokenWebhookVerifier>).verifyTokenLifecycleWebhookSignature !== "function") {
    // Structurally unreachable while "adyen" is the only registered provider, but never silently
    // accept a payload this adapter cannot actually verify.
    throw new ValidationError("No Adyen provider is configured to verify this webhook.");
  }
  return provider as unknown as AdyenTokenWebhookVerifier;
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createAdyenTokenWebhookHandler(resolveVerifier(), getAdyenTokenLifecycleService())(request);
}

export const POST = withErrorHandling("adyen_token_lifecycle_webhook", handleWebhook);
