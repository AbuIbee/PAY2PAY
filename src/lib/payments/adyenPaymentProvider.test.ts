import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  AdyenPaymentProvider,
  buildHmacSigningString,
  computeAdyenHmac,
  escapeHmacField,
  mapAdyenEventCode,
  type AdyenNotificationRequestItem,
} from "./adyenPaymentProvider";

const CONFIG = {
  apiKey: "AQEyhmfxK...test-api-key",
  merchantAccount: "Paid2YouECOM",
  liveUrlPrefix: "1797a841fbb37ca7-Paid2You",
  hmacKey: Buffer.from("a-test-hmac-key-32-bytes-long!!").toString("base64"),
};

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function signItem(item: AdyenNotificationRequestItem): string {
  return computeAdyenHmac(CONFIG.hmacKey, buildHmacSigningString(item));
}

function notificationBody(item: AdyenNotificationRequestItem, sign = true): string {
  const signed: AdyenNotificationRequestItem = sign
    ? { ...item, additionalData: { ...item.additionalData, hmacSignature: signItem(item) } }
    : item;
  return JSON.stringify({ notificationItems: [{ NotificationRequestItem: signed }] });
}

describe("AdyenPaymentProvider (PAID2YOU — B0-D ADYEN PHASE 1)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("HMAC signing-string construction — verified against Adyen's own published example", () => {
    it("matches Adyen's documented example string exactly, including the empty-originalReference double-colon", () => {
      const item: AdyenNotificationRequestItem = {
        pspReference: "7914073381342284",
        originalReference: undefined,
        merchantAccountCode: "TestMerchant",
        merchantReference: "TestPayment-1407325143704",
        amount: { value: 1130, currency: "EUR" },
        eventCode: "AUTHORISATION",
        success: "true",
      };
      expect(buildHmacSigningString(item)).toBe("7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true");
    });

    it("escapes backslashes before colons, never double-escaping", () => {
      expect(escapeHmacField("a:b")).toBe("a\\:b");
      expect(escapeHmacField("a\\b")).toBe("a\\\\b");
      expect(escapeHmacField("a\\:b")).toBe("a\\\\\\:b");
    });
  });

  describe("verifyWebhookSignature", () => {
    it("accepts a correctly-signed Adyen notification", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      const item: AdyenNotificationRequestItem = {
        pspReference: "psp_1",
        merchantAccountCode: CONFIG.merchantAccount,
        merchantReference: "ref_1",
        amount: { value: 1000, currency: "USD" },
        eventCode: "AUTHORISATION",
        success: "true",
      };
      expect(provider.verifyWebhookSignature(notificationBody(item), "")).toBe(true);
    });

    it("rejects a tampered body (amount changed after signing) — before any mutation could occur", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      const item: AdyenNotificationRequestItem = {
        pspReference: "psp_2",
        merchantAccountCode: CONFIG.merchantAccount,
        amount: { value: 1000, currency: "USD" },
        eventCode: "AUTHORISATION",
        success: "true",
      };
      const signed = notificationBody(item);
      const tampered = signed.replace('"value":1000', '"value":999999');
      expect(provider.verifyWebhookSignature(tampered, "")).toBe(false);
    });

    it("rejects a notification signed with the wrong HMAC key", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      const wrongKey = Buffer.from("a-completely-different-key-32-b").toString("base64");
      const item: AdyenNotificationRequestItem = { pspReference: "psp_3", eventCode: "AUTHORISATION", success: "true" };
      const wrongSignature = computeAdyenHmac(wrongKey, buildHmacSigningString(item));
      const body = JSON.stringify({ notificationItems: [{ NotificationRequestItem: { ...item, additionalData: { hmacSignature: wrongSignature } } }] });
      expect(provider.verifyWebhookSignature(body, "")).toBe(false);
    });

    it("rejects a payload with zero notification items", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(provider.verifyWebhookSignature(JSON.stringify({ notificationItems: [] }), "")).toBe(false);
    });

    it("rejects a batched payload with more than one notification item (module doc comment item 8) — never silently verifies only the first", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      const item: AdyenNotificationRequestItem = { pspReference: "psp_4", eventCode: "AUTHORISATION", success: "true" };
      const signature = signItem(item);
      const batched = JSON.stringify({
        notificationItems: [
          { NotificationRequestItem: { ...item, additionalData: { hmacSignature: signature } } },
          { NotificationRequestItem: { ...item, pspReference: "psp_5", additionalData: { hmacSignature: signature } } },
        ],
      });
      expect(provider.verifyWebhookSignature(batched, "")).toBe(false);
    });

    it("rejects malformed JSON", () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(provider.verifyWebhookSignature("not json", "")).toBe(false);
    });
  });

  describe("parseWebhookEvent — event mapping", () => {
    const provider = new AdyenPaymentProvider(CONFIG);

    function parse(item: AdyenNotificationRequestItem) {
      return provider.parseWebhookEvent(notificationBody(item));
    }

    it("AUTHORISATION success -> payment.succeeded, carrying the pspReference as providerPaymentId", () => {
      const parsed = parse({ pspReference: "psp_auth_1", eventCode: "AUTHORISATION", success: "true", amount: { value: 500, currency: "USD" } });
      expect(parsed.eventType).toBe("payment.succeeded");
      expect(parsed.data.providerPaymentId).toBe("psp_auth_1");
      expect(parsed.data.amountMinorUnits).toBe(500);
      expect(parsed.data.currency).toBe("USD");
      // PAID2YOU — B0-D ADYEN PHASE 1A (blocker 4): genuinely unknown, never a real $0 — see module doc comment.
      expect(parsed.data.processorFeeMinorUnits).toBeNull();
      expect(parsed.data.platformFeeMinorUnits).toBeNull();
    });

    it("AUTHORISATION failure -> payment.failed, with a failureCategory", () => {
      const parsed = parse({ pspReference: "psp_auth_2", eventCode: "AUTHORISATION", success: "false", reason: "insufficient_funds" });
      expect(parsed.eventType).toBe("payment.failed");
      expect(parsed.data.failureCategory).toBe("insufficient_funds");
    });

    it("REFUND success -> payment.refunded, carrying originalReference (not the refund's own pspReference) as providerPaymentId", () => {
      const parsed = parse({ pspReference: "psp_refund_new", originalReference: "psp_original_payment", eventCode: "REFUND", success: "true" });
      expect(parsed.eventType).toBe("payment.refunded");
      expect(parsed.data.providerPaymentId).toBe("psp_original_payment");
    });

    it("CHARGEBACK success (ACH return) -> payment.returned, NOT payment.reversed (reserved for card chargebacks — see module doc comment item 6)", () => {
      const parsed = parse({ pspReference: "psp_cb_new", originalReference: "psp_original_payment_2", eventCode: "CHARGEBACK", success: "true" });
      expect(parsed.eventType).toBe("payment.returned");
    });

    it("CANCELLATION success -> payment.canceled (Phase 1A blocker 3 — now mapped, since cancel no longer finalizes synchronously)", () => {
      const parsed = parse({ pspReference: "psp_cancel_1", originalReference: "psp_original_1", eventCode: "CANCELLATION", success: "true" });
      expect(parsed.eventType).toBe("payment.canceled");
      expect(parsed.data.providerPaymentId).toBe("psp_original_1");
    });

    it("CANCELLATION failure -> no transition (correctly stays whatever it already was)", () => {
      const parsed = parse({ pspReference: "psp_cancel_2", eventCode: "CANCELLATION", success: "false" });
      expect(parsed.eventType).toBe("adyen.unmapped.cancellation");
    });

    it("REFUND_FAILED success:false -> payment.refund_failed (Phase 1C item 1: now mapped — Adyen only ever sends this eventCode with success:false, and only after an earlier confirmed REFUND)", () => {
      const parsed = parse({ pspReference: "psp_rf_1", originalReference: "psp_original_rf_1", eventCode: "REFUND_FAILED", success: "false" });
      expect(parsed.eventType).toBe("payment.refund_failed");
      expect(parsed.data.providerPaymentId).toBe("psp_original_rf_1");
    });

    it("REFUND_FAILED success:true -> no mapping (fail-closed: Adyen is not documented to ever send this eventCode with success:true, so this is never guessed at)", () => {
      const parsed = parse({ pspReference: "psp_rf_2", eventCode: "REFUND_FAILED", success: "true" });
      expect(parsed.eventType).toBe("adyen.unmapped.refund_failed");
    });

    it("REFUNDED_REVERSED success -> payment.refund_reversed (Phase 1B item 1: now mapped, to a status distinct from 'succeeded' — see module doc comment)", () => {
      const parsed = parse({ pspReference: "psp_rr_1", originalReference: "psp_original_rr_1", eventCode: "REFUNDED_REVERSED", success: "true" });
      expect(parsed.eventType).toBe("payment.refund_reversed");
      expect(parsed.data.providerPaymentId).toBe("psp_original_rr_1");
    });

    it("REFUNDED_REVERSED failure -> no transition (Adyen attempted the reversal and could not; the refund correctly remains refunded)", () => {
      const parsed = parse({ pspReference: "psp_rr_2", eventCode: "REFUNDED_REVERSED", success: "false" });
      expect(parsed.eventType).toBe("adyen.unmapped.refunded_reversed");
    });

    it("CAPTURE is not mapped for ACH Direct Debit (module doc comment)", () => {
      const parsed = parse({ pspReference: "psp_cap_1", eventCode: "CAPTURE", success: "true" });
      expect(parsed.eventType).toBe("adyen.unmapped.capture");
    });

    it("mapAdyenEventCode: exhaustively documents the mapping table this phase implements", () => {
      expect(mapAdyenEventCode("AUTHORISATION", true)).toBe("payment.succeeded");
      expect(mapAdyenEventCode("AUTHORISATION", false)).toBe("payment.failed");
      expect(mapAdyenEventCode("CANCELLATION", true)).toBe("payment.canceled");
      expect(mapAdyenEventCode("CANCELLATION", false)).toBeNull();
      expect(mapAdyenEventCode("REFUND", true)).toBe("payment.refunded");
      expect(mapAdyenEventCode("REFUND", false)).toBeNull();
      expect(mapAdyenEventCode("CHARGEBACK", true)).toBe("payment.returned");
      expect(mapAdyenEventCode("REFUND_FAILED", false)).toBe("payment.refund_failed");
      expect(mapAdyenEventCode("REFUND_FAILED", true)).toBeNull();
      expect(mapAdyenEventCode("REFUNDED_REVERSED", true)).toBe("payment.refund_reversed");
      expect(mapAdyenEventCode("REFUNDED_REVERSED", false)).toBeNull();
      expect(mapAdyenEventCode("CAPTURE", true)).toBeNull();
      expect(mapAdyenEventCode("SOME_FUTURE_EVENT", true)).toBeNull();
    });

    it("throws ValidationError, never returns a fabricated event, for a batched (>1 item) or empty payload", () => {
      expect(() => provider.parseWebhookEvent(JSON.stringify({ notificationItems: [] }))).toThrow(ValidationError);
      const item: AdyenNotificationRequestItem = { pspReference: "psp_x", eventCode: "AUTHORISATION", success: "true" };
      const batched = JSON.stringify({
        notificationItems: [{ NotificationRequestItem: item }, { NotificationRequestItem: { ...item, pspReference: "psp_y" } }],
      });
      expect(() => provider.parseWebhookEvent(batched)).toThrow(ValidationError);
    });

    it("throws ValidationError for a missing eventCode/pspReference", () => {
      expect(() => provider.parseWebhookEvent(JSON.stringify({ notificationItems: [{ NotificationRequestItem: {} }] }))).toThrow(ValidationError);
    });
  });

  describe("createPayment", () => {
    it("Phase 1A blocker 1: submits a correctly-mapped /payments request using the EXACT providerPaymentMethodRef supplied — never looks anything up", async () => {
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        expect(url.endsWith("/payments")).toBe(true);
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          merchantAccount: CONFIG.merchantAccount,
          reference: "idem-key-1",
          amount: { value: 5000, currency: "USD" },
          paymentMethod: { type: "ach", storedPaymentMethodId: "stored_ach_exact_ref" },
          shopperReference: "personal:payer-1",
          shopperInteraction: "ContAuth",
          recurringProcessingModel: "Subscription",
        });
        expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-key-1");
        expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(CONFIG.apiKey);
        return jsonResponse(200, { pspReference: "psp_new_payment", resultCode: "Received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const provider = new AdyenPaymentProvider(CONFIG);
      const result = await provider.createPayment({
        idempotencyKey: "idem-key-1",
        amountMinorUnits: 5000,
        currency: "USD",
        payer: PAYER,
        recipient: { profileKind: "business", profileId: "recipient-1" },
        providerPaymentMethodRef: "stored_ach_exact_ref",
      });

      expect(result).toEqual({ providerPaymentId: "psp_new_payment", status: "pending" });
      // Exactly ONE network call — no /paymentMethods lookup, no guessing.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("Phase 1A blocker 1: fails closed when providerPaymentMethodRef is missing — never looks one up, never guesses", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER }),
      ).rejects.toThrow(ValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("Phase 1A blocker 1: fails closed when providerPaymentMethodRef is an empty/whitespace string", async () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "   " }),
      ).rejects.toThrow(ValidationError);
    });

    it("targets the account-specific live URL prefix, never a test.adyen.com host", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(url).toBe(`https://${CONFIG.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/v72/payments`);
        return jsonResponse(200, { pspReference: "psp_1", resultCode: "Received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      await provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" });
      for (const call of fetchMock.mock.calls) {
        expect((call[0] as string)).not.toMatch(/test/i);
      }
    });

    it("same idempotency key: sends the identical Idempotency-Key header both times, and returns the identical providerPaymentId Adyen's own dedup returns", async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("same-key");
        // Simulates Adyen's own idempotency-key dedup: the SAME pspReference both times.
        return jsonResponse(200, { pspReference: "psp_idempotent", resultCode: "Received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      const input = { idempotencyKey: "same-key", amountMinorUnits: 100, currency: "USD" as const, payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" };
      const first = await provider.createPayment(input);
      const second = await provider.createPayment(input);
      expect(second.providerPaymentId).toBe(first.providerPaymentId);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects a non-USD currency — ACH Direct Debit is a US-only rail", async () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "EUR", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a non-positive or non-integer amount", async () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 0, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" }),
      ).rejects.toThrow(ValidationError);
    });

    it("Phase 1A blocker 2: a network-layer failure throws AmbiguousProviderResponseError, not a plain ValidationError", async () => {
      global.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      const { AmbiguousProviderResponseError } = await import("@/lib/failedPayments/failedPaymentRetryCoordinator");
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" }),
      ).rejects.toThrow(AmbiguousProviderResponseError);
    });

    it("Phase 1A blocker 2: a 5xx response throws AmbiguousProviderResponseError (Adyen's own outcome is unknown), a 4xx throws a definite ValidationError", async () => {
      const { AmbiguousProviderResponseError } = await import("@/lib/failedPayments/failedPaymentRetryCoordinator");
      global.fetch = vi.fn(async () => jsonResponse(503, { errorCode: "900" })) as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(
        provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" }),
      ).rejects.toThrow(AmbiguousProviderResponseError);

      global.fetch = vi.fn(async () => jsonResponse(422, { errorCode: "137" })) as unknown as typeof fetch;
      let threw: unknown;
      try {
        await provider.createPayment({ idempotencyKey: "k2", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" });
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(ValidationError);
      expect(threw).not.toBeInstanceOf(AmbiguousProviderResponseError);
    });
  });

  describe("cancelPayment", () => {
    it("submits a correctly-shaped /payments/{pspReference}/cancels request and returns accepted (not confirmed)", async () => {
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(`https://${CONFIG.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/v72/payments/psp_123/cancels`);
        expect(JSON.parse(init.body as string)).toEqual({ merchantAccount: CONFIG.merchantAccount, reference: "cancel-psp_123" });
        return jsonResponse(200, { pspReference: "psp_cancel_req", status: "received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(await provider.cancelPayment("psp_123")).toEqual({ canceled: true });
    });

    it("returns canceled:false (never throws) when Adyen rejects the cancellation request", async () => {
      global.fetch = vi.fn(async () => jsonResponse(422, { errorCode: "137", message: "refused" })) as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(await provider.cancelPayment("psp_123")).toEqual({ canceled: false });
    });
  });

  describe("refundPayment", () => {
    it("submits a correctly-shaped /payments/{pspReference}/refunds request for a full refund", async () => {
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(`https://${CONFIG.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/v72/payments/psp_456/refunds`);
        const body = JSON.parse(init.body as string);
        expect(body.merchantAccount).toBe(CONFIG.merchantAccount);
        expect(typeof body.reference).toBe("string");
        return jsonResponse(200, { pspReference: "psp_refund_req", status: "received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(await provider.refundPayment("psp_456")).toEqual({ providerRefundId: "psp_refund_req" });
    });

    it("rejects a partial-amount refund — the interface does not carry the currency a partial Adyen refund requires", async () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      await expect(provider.refundPayment("psp_456", 100)).rejects.toThrow(ValidationError);
    });

    it("Phase 1A blocker 3: uses a DETERMINISTIC reference/Idempotency-Key (no random component) — a second refund request for the same payment reuses the identical key, so Adyen's own idempotency semantics catch a duplicate request rather than nothing locally distinguishing it from the first", async () => {
      const seenKeys: string[] = [];
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        seenKeys.push((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
        expect(body.reference).toBe((init.headers as Record<string, string>)["Idempotency-Key"]);
        return jsonResponse(200, { pspReference: "psp_refund_req", status: "received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const provider = new AdyenPaymentProvider(CONFIG);
      await provider.refundPayment("psp_789");
      await provider.refundPayment("psp_789");
      expect(seenKeys[0]).toBe(seenKeys[1]);
      expect(seenKeys[0]).toBe("refund-psp_789");
    });
  });

  describe("PAID2YOU — B0-D ADYEN PHASE 2 (bank-account collection/tokenization)", () => {
    it("deriveShopperReference is pure and matches createPayment's own shopperReference derivation exactly", async () => {
      const provider = new AdyenPaymentProvider(CONFIG);
      expect(provider.deriveShopperReference(PAYER)).toBe("personal:payer-1");

      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.shopperReference).toBe(provider.deriveShopperReference(PAYER));
        return jsonResponse(200, { pspReference: "psp_1", resultCode: "Received" });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      await provider.createPayment({ idempotencyKey: "k1", amountMinorUnits: 100, currency: "USD", payer: PAYER, recipient: PAYER, providerPaymentMethodRef: "ref_1" });
    });

    describe("createBankAccountSession", () => {
      it("submits a correctly-shaped /sessions request (zero-value auth, storePaymentMethodMode enabled, caller-supplied reference) and returns id/sessionData", async () => {
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
          expect(url).toBe(`https://${CONFIG.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/v72/sessions`);
          const body = JSON.parse(init.body as string);
          expect(body.merchantAccount).toBe(CONFIG.merchantAccount);
          expect(body.reference).toBe("attempt-ref-1");
          expect(body.amount).toEqual({ value: 0, currency: "USD" });
          expect(body.shopperReference).toBe("personal:payer-1");
          expect(body.storePaymentMethodMode).toBe("enabled");
          expect(body.returnUrl).toBe("https://app.test/payment-methods/add-bank");
          expect(body.allowedPaymentMethods).toEqual(["ach"]);
          return jsonResponse(200, { id: "sess_123", sessionData: "opaque-session-data" });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        const result = await provider.createBankAccountSession({
          shopperReference: "personal:payer-1",
          returnUrl: "https://app.test/payment-methods/add-bank",
          merchantReference: "attempt-ref-1",
        });
        expect(result).toEqual({ providerSessionId: "sess_123", sessionData: "opaque-session-data" });
      });

      it("rejects an empty shopperReference before any network call", async () => {
        const fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(
          provider.createBankAccountSession({ shopperReference: "  ", returnUrl: "https://app.test", merchantReference: "ref-1" }),
        ).rejects.toThrow(ValidationError);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("rejects an empty merchantReference before any network call — PHASE 2A: the caller must always supply the correlation key, never generated internally", async () => {
        const fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(
          provider.createBankAccountSession({ shopperReference: "personal:payer-1", returnUrl: "https://app.test", merchantReference: "  " }),
        ).rejects.toThrow(ValidationError);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("throws (never fabricates a session) when Adyen's response is missing id/sessionData", async () => {
        global.fetch = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(
          provider.createBankAccountSession({ shopperReference: "personal:payer-1", returnUrl: "https://app.test", merchantReference: "ref-1" }),
        ).rejects.toThrow(ValidationError);
      });

      it("a 4xx from Adyen (e.g. missing config on Adyen's side) surfaces as a real error — never a fabricated success", async () => {
        global.fetch = vi.fn(async () => jsonResponse(422, { errorCode: "000" })) as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(
          provider.createBankAccountSession({ shopperReference: "personal:payer-1", returnUrl: "https://app.test", merchantReference: "ref-1" }),
        ).rejects.toThrow(ValidationError);
      });
    });

    describe("disableStoredPaymentMethod", () => {
      it("submits a correctly-shaped DELETE /storedPaymentMethods/{id} request", async () => {
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
          expect(url).toBe(
            `https://${CONFIG.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/v72/storedPaymentMethods/sm_123?shopperReference=personal%3Apayer-1&merchantAccount=${encodeURIComponent(CONFIG.merchantAccount)}`,
          );
          expect(init.method).toBe("DELETE");
          return new Response(null, { status: 204 });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(provider.disableStoredPaymentMethod({ shopperReference: "personal:payer-1", storedPaymentMethodId: "sm_123" })).resolves.toBeUndefined();
      });

      it("a genuine 4xx/5xx from Adyen surfaces as a real error — never silently swallowed", async () => {
        global.fetch = vi.fn(async () => jsonResponse(422, { errorCode: "000" })) as unknown as typeof fetch;
        const provider = new AdyenPaymentProvider(CONFIG);
        await expect(provider.disableStoredPaymentMethod({ shopperReference: "personal:payer-1", storedPaymentMethodId: "sm_123" })).rejects.toThrow(ValidationError);
      });
    });

    describe("verifyTokenLifecycleWebhookSignature / parseTokenLifecycleWebhookEvent", () => {
      const recurringConfig = { ...CONFIG, recurringHmacKey: Buffer.from("a-recurring-hmac-key-32-bytes!!!").toString("hex") };

      function signRawBody(hmacKeyHex: string, rawBody: string): string {
        return createHmac("sha256", Buffer.from(hmacKeyHex, "hex")).update(rawBody, "utf8").digest("base64");
      }

      it("accepts a correctly-signed body with the expected protocol header", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        const rawBody = JSON.stringify({
          eventId: "psp_origin_1",
          type: "recurring.token.created",
          data: { storedPaymentMethodId: "sm_1", shopperReference: "personal:payer-1", merchantAccount: CONFIG.merchantAccount },
        });
        const signature = signRawBody(recurringConfig.recurringHmacKey, rawBody);
        expect(provider.verifyTokenLifecycleWebhookSignature(rawBody, signature, "HmacSHA256")).toBe(true);
      });

      it("rejects a tampered body", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        const rawBody = JSON.stringify({
          eventId: "psp_origin_1",
          type: "recurring.token.created",
          data: { storedPaymentMethodId: "sm_1", shopperReference: "personal:payer-1", merchantAccount: CONFIG.merchantAccount },
        });
        const signature = signRawBody(recurringConfig.recurringHmacKey, rawBody);
        const tampered = rawBody.replace("sm_1", "sm_2");
        expect(provider.verifyTokenLifecycleWebhookSignature(tampered, signature, "HmacSHA256")).toBe(false);
      });

      it("rejects a wrong protocol header, even with a correct signature", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        const rawBody = JSON.stringify({ eventId: "psp_1", type: "recurring.token.created", data: {} });
        const signature = signRawBody(recurringConfig.recurringHmacKey, rawBody);
        expect(provider.verifyTokenLifecycleWebhookSignature(rawBody, signature, "SomethingElse")).toBe(false);
      });

      it("rejects a missing signature header", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        expect(provider.verifyTokenLifecycleWebhookSignature("{}", null, "HmacSHA256")).toBe(false);
      });

      it("fails closed when recurringHmacKey is not configured — never verifies", () => {
        const provider = new AdyenPaymentProvider(CONFIG); // no recurringHmacKey
        const rawBody = "{}";
        const signature = signRawBody(recurringConfig.recurringHmacKey, rawBody);
        expect(provider.verifyTokenLifecycleWebhookSignature(rawBody, signature, "HmacSHA256")).toBe(false);
      });

      it("PAID2YOU — B0-D ADYEN PHASE 2A: parses a well-formed event, including the new pspReference (eventId) and merchantAccount fields required for correlation", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        const rawBody = JSON.stringify({
          eventId: "psp_origin_1",
          type: "recurring.token.disabled",
          data: { storedPaymentMethodId: "sm_1", shopperReference: "personal:payer-1", merchantAccount: CONFIG.merchantAccount },
        });
        expect(provider.parseTokenLifecycleWebhookEvent(rawBody)).toEqual({
          eventType: "recurring.token.disabled",
          pspReference: "psp_origin_1",
          storedPaymentMethodId: "sm_1",
          shopperReference: "personal:payer-1",
          merchantAccount: CONFIG.merchantAccount,
        });
      });

      it("returns null (never throws) for malformed JSON or a missing required field, including a missing eventId/merchantAccount", () => {
        const provider = new AdyenPaymentProvider(recurringConfig);
        expect(provider.parseTokenLifecycleWebhookEvent("not json")).toBeNull();
        expect(provider.parseTokenLifecycleWebhookEvent(JSON.stringify({ eventId: "psp_1", type: "recurring.token.disabled", data: {} }))).toBeNull();
        expect(
          provider.parseTokenLifecycleWebhookEvent(
            JSON.stringify({ type: "recurring.token.disabled", data: { storedPaymentMethodId: "sm_1", shopperReference: "p:1", merchantAccount: "m" } }),
          ),
        ).toBeNull(); // missing eventId (pspReference)
        expect(
          provider.parseTokenLifecycleWebhookEvent(
            JSON.stringify({ eventId: "psp_1", type: "recurring.token.disabled", data: { storedPaymentMethodId: "sm_1", shopperReference: "p:1" } }),
          ),
        ).toBeNull(); // missing merchantAccount
      });
    });

    describe("PAID2YOU — B0-D ADYEN PHASE 2A: parseWebhookEvent carries merchantReference for bank-link correlation", () => {
      it("includes merchantReference and success in the parsed data for an AUTHORISATION event", () => {
        const provider = new AdyenPaymentProvider(CONFIG);
        const rawBody = notificationBody({
          pspReference: "psp_1",
          eventCode: "AUTHORISATION",
          success: "true",
          merchantReference: "bank-attempt-ref-1",
          merchantAccountCode: CONFIG.merchantAccount,
        });
        const parsed = provider.parseWebhookEvent(rawBody);
        expect(parsed.data.merchantReference).toBe("bank-attempt-ref-1");
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.merchantAccountCode).toBe(CONFIG.merchantAccount);
      });

      it("merchantReference is null when Adyen's notification omits it", () => {
        const provider = new AdyenPaymentProvider(CONFIG);
        const rawBody = notificationBody({ pspReference: "psp_1", eventCode: "AUTHORISATION", success: "false" });
        const parsed = provider.parseWebhookEvent(rawBody);
        expect(parsed.data.merchantReference).toBeNull();
      });
    });
  });

  describe("deliberately unimplemented this phase (later B0-D phases) — never silently succeed, never reintroduce sandbox behavior", () => {
    const provider = new AdyenPaymentProvider(CONFIG);

    it("createRecipientAccount throws", async () => {
      await expect(provider.createRecipientAccount({ recipient: PAYER })).rejects.toThrow(/not implemented in B0-D Adyen Phase 1/);
    });
    it("linkBankAccount throws — superseded by createBankAccountSession (B0-D Adyen Phase 2)", async () => {
      await expect(provider.linkBankAccount({ profile: PAYER, providerAccountId: "x" })).rejects.toThrow(/superseded by createBankAccountSession/);
    });
    it("tokenizeBankAccount throws — never collects/invents raw bank credentials; superseded by createBankAccountSession (B0-D Adyen Phase 2)", async () => {
      await expect(
        provider.tokenizeBankAccount({ profile: PAYER, routingNumber: "021000021", accountNumber: "123456789012", accountSubtype: "checking", accountHolderName: "Jordan Payer" }),
      ).rejects.toThrow(/superseded by createBankAccountSession/);
    });
    it("createPaymentMethodToken throws — superseded by createBankAccountSession (B0-D Adyen Phase 2)", async () => {
      await expect(provider.createPaymentMethodToken({ profile: PAYER, methodKind: "ach" })).rejects.toThrow(/superseded by createBankAccountSession/);
    });
    it("Phase 1A blocker 2: retrievePayment throws the specifically-typed ProviderCapabilityUnsupportedError, not a plain Error, rather than fabricating a lookup Adyen's API cannot actually perform", async () => {
      const { ProviderCapabilityUnsupportedError } = await import("@/lib/errors");
      await expect(provider.retrievePayment("psp_1")).rejects.toThrow(ProviderCapabilityUnsupportedError);
      await expect(provider.retrievePayment("psp_1")).rejects.toThrow(/no GET-by-pspReference endpoint/);
    });
    it("Phase 1A blocker 2: retrievePaymentByIdempotencyKey throws the specifically-typed ProviderCapabilityUnsupportedError — no caller invokes this anymore (see FailedPaymentRetryCoordinator's own rewrite)", async () => {
      const { ProviderCapabilityUnsupportedError } = await import("@/lib/errors");
      await expect(provider.retrievePaymentByIdempotencyKey("k1")).rejects.toThrow(ProviderCapabilityUnsupportedError);
    });
  });

  it("never constructs a class named SandboxPaymentProvider or anything resembling one — providerName/providerEnvironment are the real, production values", () => {
    const provider = new AdyenPaymentProvider(CONFIG);
    expect(provider.providerName).toBe("adyen");
    expect(provider.providerEnvironment).toBe("production");
    expect(provider.constructor.name).not.toMatch(/sandbox/i);
  });
});

// Independent, from-scratch HMAC computation (not reusing computeAdyenHmac) — proves the exported
// helper is not merely self-consistent but actually implements the standard HMAC-SHA256 algorithm
// Adyen documents.
describe("computeAdyenHmac — independent cross-check", () => {
  it("matches a directly-computed Node crypto HMAC-SHA256 over the same signing string and key", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex").toString("base64");
    const signingString = "psp:orig:merchant:ref:100:USD:AUTHORISATION:true";
    const expected = createHmac("sha256", Buffer.from(key, "base64")).update(signingString, "utf8").digest("base64");
    expect(computeAdyenHmac(key, signingString)).toBe(expected);
  });
});
