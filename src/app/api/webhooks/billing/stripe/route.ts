import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getPlatformBillingWebhookService } from "@/lib/organizations/getPlatformBillingWebhookService";
import type { PlatformBillingWebhookService } from "@/lib/organizations/platformBillingWebhookService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 24: Stripe's own webhook delivery endpoint for
 * Paid2You's subscription billing domain — NEVER the customer-repayment path
 * (src/app/api/payments/webhook/route.ts is the separate, unrelated endpoint for that). Signature
 * verification against the raw request body (header "stripe-signature", via the official
 * `stripe.webhooks.constructEvent`) is the sole gate — same raw-text-read precedent as every other
 * webhook route in this codebase. 503 when Stripe billing is not configured; Stripe itself retries
 * non-2xx responses, so this is safe.
 */
export function createStripeBillingWebhookHandler(service: PlatformBillingWebhookService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("stripe-signature") ?? "";
    const result = await service.receiveWebhook({ rawBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createStripeBillingWebhookHandler(getPlatformBillingWebhookService())(request);
}

export const POST = withErrorHandling("platform_billing_webhook_stripe", handleWebhook);
