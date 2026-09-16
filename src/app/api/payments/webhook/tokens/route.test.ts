import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdyenTokenLifecycleService } from "@/lib/payments/adyenTokenLifecycleService";
import { createAdyenTokenWebhookHandler, type AdyenTokenWebhookVerifier } from "./route";

function handler(verifier: AdyenTokenWebhookVerifier, lifecycleService: Pick<AdyenTokenLifecycleService, "handleEvent">) {
  return withErrorHandling("adyen_token_lifecycle_webhook", createAdyenTokenWebhookHandler(verifier, lifecycleService as AdyenTokenLifecycleService));
}

function postRaw(body: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/payments/webhook/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/payments/webhook/tokens", () => {
  it("fails closed (403) on an invalid signature — never calls the lifecycle service", async () => {
    const verifier: AdyenTokenWebhookVerifier = {
      verifyTokenLifecycleWebhookSignature: () => false,
      parseTokenLifecycleWebhookEvent: () => null,
    };
    const handleEvent = vi.fn();
    const response = await handler(verifier, { handleEvent })(postRaw('{"type":"recurring.token.disabled"}', { hmacsignature: "bad", protocol: "HmacSHA256" }));
    expect(response.status).toBe(403);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("accepts (200, ignored) a validly-signed but unparseable body — never treats it as a lifecycle event", async () => {
    const verifier: AdyenTokenWebhookVerifier = {
      verifyTokenLifecycleWebhookSignature: () => true,
      parseTokenLifecycleWebhookEvent: () => null,
    };
    const handleEvent = vi.fn();
    const response = await handler(verifier, { handleEvent })(postRaw("not json", { hmacsignature: "good", protocol: "HmacSHA256" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ignored");
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("processes a validly-signed, well-formed event and hands it to the lifecycle service unchanged", async () => {
    const event = {
      eventType: "recurring.token.disabled",
      pspReference: "psp_1",
      storedPaymentMethodId: "sm_1",
      shopperReference: "personal:p1",
      merchantAccount: "Paid2YouECOM",
    };
    const verifier: AdyenTokenWebhookVerifier = {
      verifyTokenLifecycleWebhookSignature: () => true,
      parseTokenLifecycleWebhookEvent: () => event,
    };
    const handleEvent = vi.fn().mockResolvedValue(undefined);
    const response = await handler(verifier, { handleEvent })(
      postRaw(JSON.stringify({ type: "recurring.token.disabled", data: event }), { hmacsignature: "good", protocol: "HmacSHA256" }),
    );
    expect(response.status).toBe(200);
    expect(handleEvent).toHaveBeenCalledWith(event);
  });
});
