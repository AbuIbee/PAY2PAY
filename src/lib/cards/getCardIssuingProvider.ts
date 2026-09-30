import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { CardIssuingProvider } from "./cardIssuingProvider";

// `const`, not `let` — genuinely never reassigned today: the body below always throws before reaching
// a point that would assign it (see this function's own doc comment).
const cached: CardIssuingProvider | null = null;

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-01) — see
 * getPaymentProvider.ts's identical doc comment for the fail-closed runtime-switch/registry pattern
 * this mirrors. `PROVIDER_CAPABILITY_REGISTRY` has no card-issuing entry — no vendor has been
 * selected — so this always throws `ProviderNotAvailableError` today.
 */
export function getCardIssuingProvider(): CardIssuingProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("card_issuing", env.CARD_ISSUING_PROVIDER, env.APP_ENV);
    throw new ConfigurationError(`No card-issuing provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
