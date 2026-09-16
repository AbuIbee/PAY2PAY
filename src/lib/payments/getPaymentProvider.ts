import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import { AdyenPaymentProvider } from "./adyenPaymentProvider";
import type { PaymentProvider } from "./paymentProvider";

let cached: PaymentProvider | null = null;

/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION established the fail-closed shape here:
 * `assertProviderAvailableForRuntime` throws `ProviderNotAvailableError` whenever `PAYMENT_PROVIDER`
 * does not resolve to a registered, live (`environment: "production"`) descriptor — never a sandbox
 * fallback. Every route/service that calls this (directly or via
 * getPaymentService.ts/getPaymentWebhookService.ts/getBankConnectionService.ts/etc.) therefore fails
 * closed before doing anything else whenever no provider is available.
 *
 * PAID2YOU — B0-D ADYEN PHASE 1: `adyen` is now a real, registered descriptor
 * (providerCapabilities.ts) — the ONLY concrete case below. Selecting it (`PAYMENT_PROVIDER=adyen`)
 * additionally requires `ADYEN_API_KEY`/`ADYEN_MERCHANT_ACCOUNT`/`ADYEN_LIVE_PREFIX`/
 * `ADYEN_PAYMENTS_HMAC_KEY` to all be configured — missing any of them throws `ConfigurationError`
 * here (a real, actionable "selected but not configured" wiring bug), distinct from
 * `ProviderNotAvailableError` (the "nothing selected yet" state). Adding a further real provider later
 * remains additive: a new `case` below, a new registry entry, no change to PaymentService or any
 * other consumer.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("payment", env.PAYMENT_PROVIDER, env.APP_ENV);
    if (descriptor.providerName === "adyen") {
      const { ADYEN_API_KEY, ADYEN_MERCHANT_ACCOUNT, ADYEN_LIVE_PREFIX, ADYEN_PAYMENTS_HMAC_KEY, ADYEN_RECURRING_HMAC_KEY } = env;
      if (!ADYEN_API_KEY || !ADYEN_MERCHANT_ACCOUNT || !ADYEN_LIVE_PREFIX || !ADYEN_PAYMENTS_HMAC_KEY) {
        throw new ConfigurationError(
          "PAYMENT_PROVIDER=adyen requires ADYEN_API_KEY, ADYEN_MERCHANT_ACCOUNT, ADYEN_LIVE_PREFIX, and ADYEN_PAYMENTS_HMAC_KEY to all be configured.",
        );
      }
      cached = new AdyenPaymentProvider({
        apiKey: ADYEN_API_KEY,
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
        liveUrlPrefix: ADYEN_LIVE_PREFIX,
        hmacKey: ADYEN_PAYMENTS_HMAC_KEY,
        // PAID2YOU — B0-D ADYEN PHASE 2: deliberately NOT required here, unlike the four above — the
        // token-lifecycle webhook is a best-effort lifecycle-sync feature (see
        // AdyenPaymentProvider's own module doc comment, Phase 2 item 3), not a prerequisite for the
        // core payment/bank-tokenization flows this factory otherwise gates. Its own route enforces
        // this is configured before accepting a delivery.
        recurringHmacKey: ADYEN_RECURRING_HMAC_KEY,
      });
      return cached;
    }
    // Unreachable today (the registry has only the "adyen" entry above) — kept as an explicit, loud
    // failure for the day a further descriptor is registered before its concrete adapter is wired here.
    throw new ConfigurationError(`No payment provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
