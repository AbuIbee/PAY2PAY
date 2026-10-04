import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import type { BusinessVerificationProvider } from "./businessVerificationProvider";
import { MiddeskBusinessVerificationProvider } from "./middeskBusinessVerificationProvider";

let cached: BusinessVerificationProvider | null = null;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 9, wired to a real adapter by "PAID2YOU —
 * MASTER P0" (2026-10-03), Section 10/11: mirrors getPaymentProvider.ts's identical
 * descriptor-check-then-construct shape (see providerCapabilities.ts's module doc comment for the
 * two-outcome contract this enforces). `middesk` is now a registered descriptor — when
 * BUSINESS_VERIFICATION_PROVIDER=middesk and MIDDESK_API_KEY/MIDDESK_WEBHOOK_SECRET are both
 * configured, this constructs a real MiddeskBusinessVerificationProvider; missing either secret
 * fails closed with a clear ConfigurationError (never a silent fallback to "verified"). Any other
 * (unregistered) provider name still throws ProviderNotAvailableError before reaching here at all —
 * business onboarding must treat that as VERIFICATION_PENDING/NOT_CONFIGURED (Section 9/Requirement
 * 29), never fabricate a verified result.
 */
export function getBusinessVerificationProvider(): BusinessVerificationProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("business_verification", env.BUSINESS_VERIFICATION_PROVIDER, env.APP_ENV);
    if (descriptor.providerName === "middesk") {
      const { MIDDESK_API_KEY, MIDDESK_WEBHOOK_SECRET, MIDDESK_API_BASE_URL } = env;
      if (!MIDDESK_API_KEY || !MIDDESK_WEBHOOK_SECRET) {
        throw new ConfigurationError("BUSINESS_VERIFICATION_PROVIDER=middesk requires MIDDESK_API_KEY and MIDDESK_WEBHOOK_SECRET to both be configured.");
      }
      cached = new MiddeskBusinessVerificationProvider({ apiKey: MIDDESK_API_KEY, webhookSecret: MIDDESK_WEBHOOK_SECRET, apiBaseUrl: MIDDESK_API_BASE_URL });
      return cached;
    }
    throw new ConfigurationError(`No business verification provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}

/** Mirrors isPlatformBillingProviderConfigured's identical non-throwing "is this honestly available" check. */
export function isBusinessVerificationProviderConfigured(): boolean {
  try {
    getBusinessVerificationProvider();
    return true;
  } catch {
    return false;
  }
}
