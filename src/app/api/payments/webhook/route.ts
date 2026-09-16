import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getPaymentWebhookService } from "@/lib/payments/getPaymentWebhookService";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { getBankConnectionServiceIfAvailable } from "@/lib/relationships/getBankConnectionService";
import type { BankConnectionService } from "@/lib/relationships/bankConnectionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Narrow interface onto exactly the two provider methods needed for the bank-link routing check below — avoids depending on the entire PaymentProvider surface. */
export interface BankLinkAuthorisationVerifier {
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): { eventType: string; data: Record<string, unknown> };
}

/**
 * Unauthenticated by design — no external payment provider can hold a PAY2PAY session cookie —
 * `PaymentWebhookService.receiveWebhook` is the sole gate, via HMAC signature verification against
 * the raw request body. Reads the body as raw text (not `request.json()`) because signature
 * verification requires the exact bytes the sender signed, not a JSON round-trip that could
 * reformat them.
 *
 * PAID2YOU — B0-D ADYEN PHASE 1: previously read a `x-sandbox-payment-signature` request header —
 * retired along with the sandbox provider. Adyen's real Standard-notification HMAC signature is
 * carried INSIDE the JSON body itself (`notificationItems[].NotificationRequestItem.additionalData
 * .hmacSignature`), never an HTTP header — see `AdyenPaymentProvider.verifyWebhookSignature`'s own
 * doc comment. `signatureHeader` is passed through only because `PaymentProvider.verifyWebhookSignature`
 * 's interface shape still takes one (unchanged, out of this phase's scope); Adyen's real
 * implementation ignores it entirely and reads the signature out of `rawBody` instead.
 *
 * PAID2YOU — B0-D ADYEN PHASE 2C (webhook isolation — corrects PHASE 2A's own design): a bank-link
 * $0-auth AUTHORISATION event is now routed EXCLUSIVELY — it is checked FIRST, and once genuinely
 * identified (`tryRouteBankLinkAuthorisation` below returns `"handled"`), this request returns 2xx
 * immediately and `PaymentWebhookService.receiveWebhook` is NEVER called for it. PHASE 2A previously
 * called `PaymentWebhookService.receiveWebhook` unconditionally for every delivery, including
 * bank-link ones — which, while provably inert there (see `PaymentWebhookService.applyEvent`'s own
 * `findByProviderPaymentId` gate — a bank-link session's pspReference never resolves to a
 * `payment_attempt` row, so it only ever produced a permanently-retryable, no-op `payment_webhook_event`
 * row), still meant a bank-link event was *passed to* that service at all. This correction removes
 * that entirely: `PaymentWebhookService` now never even sees a delivery this route has independently
 * confirmed is one of THIS server's own bank-tokenization sessions.
 *
 * Classification is never inferred from the event's shape/eventCode/amount alone — `recordAuthorisationConfirmed`
 * (`BankConnectionService`) is the sole authority, via a real `findByMerchantReference` row lookup
 * against the durable `bank_link_attempt` table. An unrecognized `merchantReference` (every OTHER
 * payment's own AUTHORISATION event) is NEVER treated as bank-link — it falls through to ordinary
 * `PaymentWebhookService` processing below, unchanged. An invalid signature is likewise never trusted
 * enough to classify anything — `tryRouteBankLinkAuthorisation` falls through in that case too, and
 * `PaymentWebhookService.receiveWebhook`'s own existing signature check is the sole place an invalid
 * signature is ever rejected (unchanged mechanism, still a 403 `ForbiddenError`) — this route never
 * duplicates that rejection itself.
 *
 * When bank-linking is unavailable (`getBankConnectionServiceIfAvailable()` returns `null` — always
 * true today, since no Adyen account/credentials/approval exist — see `getBankConnectionService.ts`),
 * `bankLinkAuthorisationDeps` is `undefined` and this function reduces to exactly the original,
 * single unconditional `paymentWebhookService.receiveWebhook` call — zero behavior change for ordinary
 * payment webhooks in the actual current production configuration.
 *
 * Idempotent throughout: a redelivered or out-of-order bank-link AUTHORISATION event is recognized
 * identically on every delivery (`recordAuthorisationConfirmed` returns `true` for any known
 * `merchantReference` regardless of the attempt's current status) — always routed away from
 * `PaymentWebhookService`, never inconsistently classified across retries.
 */
export function createPaymentWebhookHandler(paymentWebhookService: PaymentWebhookService, bankLinkAuthorisationDeps?: { verifier: BankLinkAuthorisationVerifier; bankConnections: BankConnectionService }) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const rawBody = await request.text();

    if (bankLinkAuthorisationDeps) {
      const outcome = await tryRouteBankLinkAuthorisation(bankLinkAuthorisationDeps.verifier, bankLinkAuthorisationDeps.bankConnections, rawBody);
      if (outcome === "handled") {
        return NextResponse.json({ status: "bank_link_authorisation_processed" }, { status: 200 });
      }
      // "not_bank_link" (includes an unverifiable/unparseable body, a non-AUTHORISATION event, or an
      // unrecognized merchantReference) — fall through to ordinary processing, unchanged.
    }

    const result = await paymentWebhookService.receiveWebhook({ rawBody, signatureHeader: "" });
    return NextResponse.json({ status: result.status }, { status: 200 });
  };
}

type BankLinkRoutingOutcome = "handled" | "not_bank_link";

async function tryRouteBankLinkAuthorisation(verifier: BankLinkAuthorisationVerifier, bankConnections: BankConnectionService, rawBody: string): Promise<BankLinkRoutingOutcome> {
  if (!verifier.verifyWebhookSignature(rawBody, "")) return "not_bank_link"; // unverifiable — never classified; PaymentWebhookService's own check below is the sole place this is rejected.
  let event: { eventType: string; data: Record<string, unknown> };
  try {
    event = verifier.parseWebhookEvent(rawBody);
  } catch {
    return "not_bank_link"; // PaymentWebhookService below already surfaces a parse failure for the payment side.
  }
  if (event.eventType !== "payment.succeeded" && event.eventType !== "payment.failed") return "not_bank_link";
  const merchantReference = event.data.merchantReference;
  if (typeof merchantReference !== "string" || !merchantReference) return "not_bank_link";
  const pspReference = event.data.pspReference;
  if (typeof pspReference !== "string" || !pspReference) return "not_bank_link";
  const wasBankLinkReference = await bankConnections.recordAuthorisationConfirmed({ merchantReference, pspReference, success: event.eventType === "payment.succeeded" });
  return wasBankLinkReference ? "handled" : "not_bank_link";
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  const provider = getPaymentProvider();
  const bankConnections = getBankConnectionServiceIfAvailable();
  const bankLinkAuthorisationDeps = bankConnections ? { verifier: provider, bankConnections } : undefined;
  return createPaymentWebhookHandler(getPaymentWebhookService(), bankLinkAuthorisationDeps)(request);
}

export const POST = withErrorHandling("payment_webhook", handleWebhook);
