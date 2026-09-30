import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { KycKybProvider } from "./kycProvider";

// `const`, not `let` — genuinely never reassigned today: the body below always throws before reaching
// a point that would assign it (see this function's own doc comment).
const cached: KycKybProvider | null = null;

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-01) — see
 * getPaymentProvider.ts's identical doc comment for the fail-closed runtime-switch/registry pattern
 * this mirrors. `PROVIDER_CAPABILITY_REGISTRY` has no KYC/KYB entry — no vendor has been selected —
 * so this always throws `ProviderNotAvailableError` today.
 */
export function getKycProvider(): KycKybProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("kyc", env.KYC_PROVIDER, env.APP_ENV);
    throw new ConfigurationError(`No KYC/KYB provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
