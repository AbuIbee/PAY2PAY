import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getBusinessVerificationWebhookService } from "@/lib/organizations/getBusinessVerificationWebhookService";
import type { BusinessVerificationWebhookService } from "@/lib/organizations/businessVerificationWebhookService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 14: Middesk's own webhook delivery endpoint.
 * Unauthenticated by design (no external provider holds a Paid2You session cookie) — signature
 * verification against the raw request body (header "X-Middesk-Signature-256") is the sole gate,
 * mirroring src/app/api/payments/webhook/route.ts's identical "read as raw text, never request.json(),
 * so signature verification sees the exact bytes the sender signed" precedent. 503 (via
 * `getBusinessVerificationWebhookService()` -> `getBusinessVerificationProvider()`) when Middesk is
 * not configured — Middesk itself retries webhook deliveries on a non-2xx response, so this is safe.
 */
export function createMiddeskWebhookHandler(service: BusinessVerificationWebhookService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-middesk-signature-256") ?? "";
    const result = await service.receiveWebhook({ rawBody, signatureHeader });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createMiddeskWebhookHandler(getBusinessVerificationWebhookService())(request);
}

export const POST = withErrorHandling("business_verification_webhook_middesk", handleWebhook);
