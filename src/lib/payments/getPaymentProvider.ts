import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { PaymentProvider } from "./paymentProvider";

// `const`, not `let` — genuinely never reassigned today: the body below always throws before reaching
// a point that would assign it (see this function's own doc comment). Kept as a plain variable, not
// inlined, so a future real adapter needs only to add an assignment here, no shape change.
const cached: PaymentProvider | null = null;

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-01): fail-closed shape
 * ported from the B0-D TOTAL SANDBOX ELIMINATION fix. `assertProviderAvailableForRuntime` throws
 * `ProviderNotAvailableError` whenever `PAYMENT_PROVIDER` does not resolve to a registered, live
 * (`environment: "production"`) descriptor — never a sandbox fallback. Every route/service that calls
 * this (directly or via getPaymentService.ts/getPaymentWebhookService.ts/getBankConnectionService.ts/
 * etc.) therefore fails closed before doing anything else whenever no provider is available.
 *
 * `PROVIDER_CAPABILITY_REGISTRY` (providerCapabilities.ts) is currently empty — the V3
 * bank-managed-payments provider has not been implemented or approved yet — so this function
 * unconditionally throws `ProviderNotAvailableError` today. Adding the real adapter later is additive:
 * a new `case` below, a new registry entry, no change to PaymentService or any other consumer.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("payment", env.PAYMENT_PROVIDER, env.APP_ENV);
    // Unreachable today (the registry has no entries) — kept as an explicit, loud failure for the
    // day a descriptor is registered before its concrete adapter is wired here.
    throw new ConfigurationError(`No payment provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
