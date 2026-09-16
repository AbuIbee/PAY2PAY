import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { CardIssuingProvider } from "./cardIssuingProvider";

// See getPaymentProvider.ts's identical comment: reassigned once a real provider is registered;
// today the function always throws first.
// eslint-disable-next-line prefer-const
let cached: CardIssuingProvider | null = null;

/** PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION — see getPaymentProvider.ts's identical doc comment for the fail-closed pattern this mirrors. */
export function getCardIssuingProvider(): CardIssuingProvider {
  if (!cached) {
    const { CARD_ISSUING_PROVIDER, APP_ENV } = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("card_issuing", CARD_ISSUING_PROVIDER, APP_ENV);
    throw new ConfigurationError(`No card-issuing provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
