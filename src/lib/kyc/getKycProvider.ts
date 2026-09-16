import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { KycKybProvider } from "./kycProvider";

// See getPaymentProvider.ts's identical comment: reassigned once a real provider is registered;
// today the function always throws first.
// eslint-disable-next-line prefer-const
let cached: KycKybProvider | null = null;

/** PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION — see getPaymentProvider.ts's identical doc comment for the fail-closed pattern this mirrors. */
export function getKycProvider(): KycKybProvider {
  if (!cached) {
    const { KYC_PROVIDER, APP_ENV } = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("kyc", KYC_PROVIDER, APP_ENV);
    throw new ConfigurationError(`No KYC/KYB provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}
