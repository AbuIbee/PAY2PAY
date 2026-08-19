import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderEnvironmentConsistency, getProviderCapabilityDescriptor } from "@/lib/providers/providerCapabilities";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";
import type { PaymentProvider } from "./paymentProvider";

let cached: SandboxPaymentProvider | null = null;

/**
 * PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md): a real
 * runtime switch driven by the `PAYMENT_PROVIDER` env var (src/config/env.ts), replacing Sprint 9's
 * unconditional sandbox wiring — exactly what that sprint's own doc comment anticipated ("A real
 * Stripe Connect/Plaid adapter would get its own getXProvider() and a runtime switch here driven by
 * configuration, without any change to PaymentService"). Only "sandbox" is registered today; adding a
 * real adapter later is additive (a new case here + a new registry entry in providerCapabilities.ts +
 * a new enum value on PAYMENT_PROVIDER), never a change to PaymentService or any other consumer.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    const { PAYMENT_PROVIDER, PAYMENT_SANDBOX_WEBHOOK_SECRET, APP_ENV } = getServerEnv();
    if (PAYMENT_PROVIDER === "sandbox") {
      if (!PAYMENT_SANDBOX_WEBHOOK_SECRET) {
        throw new ConfigurationError("PAYMENT_SANDBOX_WEBHOOK_SECRET is not configured.");
      }
      cached = new SandboxPaymentProvider(PAYMENT_SANDBOX_WEBHOOK_SECRET);
    } else {
      // Unreachable while the env schema's PAYMENT_PROVIDER enum only contains "sandbox" — kept as
      // an explicit, loud failure (not a silent fallback to sandbox) for the day a new enum value is
      // added to the schema before its provider factory is registered here.
      throw new ConfigurationError(`No payment provider factory is registered for "${PAYMENT_PROVIDER}".`);
    }
    assertProviderEnvironmentConsistency(getProviderCapabilityDescriptor(cached.providerName), APP_ENV);
  }
  return cached;
}

/** Test/internal-only accessor to the concrete sandbox instance (e.g. to call simulateSettlement). */
export function getSandboxPaymentProviderInstance(): SandboxPaymentProvider {
  return getPaymentProvider() as SandboxPaymentProvider;
}
