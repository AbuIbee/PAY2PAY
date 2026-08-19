import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderEnvironmentConsistency, getProviderCapabilityDescriptor } from "@/lib/providers/providerCapabilities";
import { SandboxKycProvider } from "./sandboxKycProvider";
import type { KycKybProvider } from "./kycProvider";

let cached: SandboxKycProvider | null = null;

/** PRSprint 21 — see getPaymentProvider.ts's identical doc comment for the runtime-switch/registry pattern this mirrors. */
export function getKycProvider(): KycKybProvider {
  if (!cached) {
    const { KYC_PROVIDER, KYC_SANDBOX_WEBHOOK_SECRET, APP_ENV } = getServerEnv();
    if (KYC_PROVIDER === "sandbox") {
      if (!KYC_SANDBOX_WEBHOOK_SECRET) {
        throw new ConfigurationError("KYC_SANDBOX_WEBHOOK_SECRET is not configured.");
      }
      cached = new SandboxKycProvider(KYC_SANDBOX_WEBHOOK_SECRET);
    } else {
      throw new ConfigurationError(`No KYC/KYB provider factory is registered for "${KYC_PROVIDER}".`);
    }
    assertProviderEnvironmentConsistency(getProviderCapabilityDescriptor(cached.providerName), APP_ENV);
  }
  return cached;
}
