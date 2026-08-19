import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderEnvironmentConsistency, getProviderCapabilityDescriptor } from "@/lib/providers/providerCapabilities";
import { SandboxCardIssuingProvider } from "./sandboxCardIssuingProvider";
import type { CardIssuingProvider } from "./cardIssuingProvider";

let cached: SandboxCardIssuingProvider | null = null;

/** PRSprint 24 — see getPaymentProvider.ts's identical doc comment for the runtime-switch/registry pattern this mirrors. */
export function getCardIssuingProvider(): CardIssuingProvider {
  if (!cached) {
    const { CARD_ISSUING_PROVIDER, CARD_SANDBOX_WEBHOOK_SECRET, APP_ENV } = getServerEnv();
    if (CARD_ISSUING_PROVIDER === "sandbox") {
      if (!CARD_SANDBOX_WEBHOOK_SECRET) {
        throw new ConfigurationError("CARD_SANDBOX_WEBHOOK_SECRET is not configured.");
      }
      cached = new SandboxCardIssuingProvider(CARD_SANDBOX_WEBHOOK_SECRET);
    } else {
      throw new ConfigurationError(`No card-issuing provider factory is registered for "${CARD_ISSUING_PROVIDER}".`);
    }
    assertProviderEnvironmentConsistency(getProviderCapabilityDescriptor(cached.providerName), APP_ENV);
  }
  return cached;
}
