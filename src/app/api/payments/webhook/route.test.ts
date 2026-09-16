import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { ForbiddenError } from "@/lib/errors";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";
import { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { createTestRelationshipServices, FakeBankPaymentProvider, InMemoryBankLinkAttemptRepository } from "@/lib/relationships/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { randomUUID } from "node:crypto";
import { createPaymentWebhookHandler, type BankLinkAuthorisationVerifier } from "./route";

const ADYEN_MERCHANT_ACCOUNT = "Paid2YouECOM";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2C (webhook isolation). Proves the corrected routing contract:
 *
 *   1. A genuinely-identified bank-link AUTHORISATION event (a real `findByMerchantReference` match)
 *      is handled EXCLUSIVELY here — `PaymentWebhookService.receiveWebhook` is NEVER called for it, not
 *      even once. This supersedes PHASE 2A's own design, which called `receiveWebhook` unconditionally
 *      for every delivery (provably inert there, per PHASE 2B's own verification, but still "passed to"
 *      it) — PHASE 2C removes that pass-through entirely.
 *   2. Every other delivery — an unrecognized `merchantReference`, a non-AUTHORISATION event, an
 *      unparseable body, or an unverifiable signature — falls through to `PaymentWebhookService`
 *      unchanged, which remains the sole place an invalid signature is ever rejected.
 *   3. Redelivered/out-of-order bank-link events are idempotent AND consistently routed away from
 *      `PaymentWebhookService` on every retry, never just the first delivery.
 *   4. When bank-linking is unavailable (`bankLinkAuthorisationDeps` undefined — the actual current
 *      production state, since no Adyen account exists), this reduces to the exact original
 *      single-call behavior — zero change for ordinary payment webhooks.
 */
describe("POST /api/payments/webhook — PHASE 2C bank-link webhook isolation", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let provider: FakeBankPaymentProvider;
  let bankLinkAttempts: InMemoryBankLinkAttemptRepository;
  let bankConnections: BankConnectionService;
  let receiveWebhook: ReturnType<typeof vi.fn>;
  let userId: string;
  let partyId: string;

  beforeEach(async () => {
    relCtx = createTestRelationshipServices();
    provider = new FakeBankPaymentProvider();
    bankLinkAttempts = new InMemoryBankLinkAttemptRepository();
    bankConnections = new BankConnectionService({
      provider,
      financialAccounts: relCtx.relationshipFinancialAccountService,
      bankLinkAttempts,
      mfa: relCtx.staffCtx.mfaService,
      adyenMerchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
    receiveWebhook = vi.fn().mockResolvedValue({ status: "processed" });

    userId = randomUUID();
    partyId = randomUUID();
    relCtx.profileOwners.set("personal", partyId, userId);
  });

  async function startAttempt() {
    const attemptSessionId = randomUUID();
    await grantStepUp(relCtx.staffCtx, userId, attemptSessionId);
    return bankConnections.initiateBankConnection({
      actingUserId: userId,
      actingSessionId: attemptSessionId,
      actingParty: { kind: "personal", id: partyId },
      returnUrl: "https://app.test/payment-methods/add-bank",
      institutionDisplayName: "Example Bank",
    });
  }

  function handler(verifier: BankLinkAuthorisationVerifier) {
    return withErrorHandling(
      "payment_webhook",
      createPaymentWebhookHandler({ receiveWebhook } as unknown as PaymentWebhookService, { verifier, bankConnections }),
    );
  }

  function postRaw(body: string) {
    return new NextRequest("http://localhost/api/payments/webhook", { method: "POST", headers: { "content-type": "application/json" }, body });
  }

  function verifierFor(merchantReference: string, pspReference: string, success = true): BankLinkAuthorisationVerifier {
    return {
      verifyWebhookSignature: () => true,
      parseWebhookEvent: () => ({
        eventType: success ? "payment.succeeded" : "payment.failed",
        data: { merchantReference, pspReference, success },
      }),
    };
  }

  describe("item 1/2: a genuinely-identified bank-link event is handled EXCLUSIVELY — PaymentWebhookService is never called", () => {
    it("advances the attempt to authorised and never calls PaymentWebhookService.receiveWebhook", async () => {
      const session = await startAttempt();
      const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)!;

      const response = await handler(verifierFor(attempt.merchantReference, "psp_real_123"))(postRaw("{}"));

      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("bank_link_authorisation_processed");
      expect(receiveWebhook).not.toHaveBeenCalled();
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.status).toBe("authorised");
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.confirmedPspReference).toBe("psp_real_123");
    });

    it("a success:false AUTHORISATION event marks the attempt failed, still never touching PaymentWebhookService", async () => {
      const session = await startAttempt();
      const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)!;

      const response = await handler(verifierFor(attempt.merchantReference, "psp_failed_123", false))(postRaw("{}"));

      expect(response.status).toBe(200);
      expect(receiveWebhook).not.toHaveBeenCalled();
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.status).toBe("failed");
    });
  });

  describe("item 3: unrecognized references are never silently classified as bank-link — genuine fallthrough", () => {
    it("an ordinary payment's own AUTHORISATION event (no matching merchantReference) falls through to PaymentWebhookService", async () => {
      const response = await handler(verifierFor("some-unrelated-payment-ref", "psp_unrelated"))(postRaw("{}"));
      expect(response.status).toBe(200);
      expect(receiveWebhook).toHaveBeenCalledTimes(1);
    });

    it("non-AUTHORISATION event types (e.g. REFUND) are never treated as bank-link — falls through, and never mutates any attempt", async () => {
      const session = await startAttempt();
      const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)!;
      const verifier: BankLinkAuthorisationVerifier = {
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => ({ eventType: "refund.succeeded", data: { merchantReference: attempt.merchantReference, pspReference: "psp_x", success: true } }),
      };
      const response = await handler(verifier)(postRaw("{}"));
      expect(response.status).toBe(200);
      expect(receiveWebhook).toHaveBeenCalledTimes(1);
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.status).toBe("pending");
    });

    it("an unparseable body is never classified as bank-link — falls through to PaymentWebhookService", async () => {
      const verifier: BankLinkAuthorisationVerifier = {
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => {
          throw new Error("malformed");
        },
      };
      const response = await handler(verifier)(postRaw("not json"));
      expect(response.status).toBe(200);
      expect(receiveWebhook).toHaveBeenCalledTimes(1);
    });

    it("an invalid signature is NEVER trusted enough to classify anything — falls through, and PaymentWebhookService's own check is the sole place it is rejected", async () => {
      receiveWebhook.mockRejectedValueOnce(new ForbiddenError("Webhook signature verification failed."));
      const verifier: BankLinkAuthorisationVerifier = {
        verifyWebhookSignature: () => false,
        parseWebhookEvent: () => ({ eventType: "payment.succeeded", data: { merchantReference: "irrelevant", pspReference: "psp_x", success: true } }),
      };
      const response = await handler(verifier)(postRaw("{}"));
      expect(receiveWebhook).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(403);
    });
  });

  describe("item 5: duplicates and out-of-order bank-link deliveries are idempotent, and consistently routed away from PaymentWebhookService on every retry", () => {
    it("a redelivered AUTHORISATION event for an already-authorised attempt is a safe no-op, still never reaching PaymentWebhookService", async () => {
      const session = await startAttempt();
      const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)!;
      const verifier = verifierFor(attempt.merchantReference, "psp_first_delivery");

      await handler(verifier)(postRaw("{}")); // first delivery
      const response = await handler(verifier)(postRaw("{}")); // redelivery

      expect(response.status).toBe(200);
      expect(receiveWebhook).not.toHaveBeenCalled();
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.confirmedPspReference).toBe("psp_first_delivery");
    });

    it("an AUTHORISATION event arriving AFTER the attempt already completed (out-of-order webhook delivery) is still routed away from PaymentWebhookService, never a fallthrough", async () => {
      const session = await startAttempt();
      const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)!;
      await handler(verifierFor(attempt.merchantReference, "psp_1"))(postRaw("{}"));
      await bankConnections.completeFromTokenEvent({
        pspReference: "psp_1",
        shopperReference: attempt.shopperReference,
        storedPaymentMethodId: "sm_1",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      });
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.status).toBe("completed");

      const response = await handler(verifierFor(attempt.merchantReference, "psp_1"))(postRaw("{}")); // late redelivery, after completion

      expect(response.status).toBe(200);
      expect(receiveWebhook).not.toHaveBeenCalled();
      expect(bankLinkAttempts.byProviderSessionId.get(session.providerSessionId)?.status).toBe("completed"); // unchanged.
    });
  });

  it("item 4 (regression): when bank-linking is unavailable (no bankLinkAuthorisationDeps), ordinary payment processing is entirely unaffected — the exact original single-call behavior", async () => {
    const response = await withErrorHandling("payment_webhook", createPaymentWebhookHandler({ receiveWebhook } as unknown as PaymentWebhookService))(postRaw("{}"));
    expect(response.status).toBe(200);
    expect(receiveWebhook).toHaveBeenCalledTimes(1);
  });
});
